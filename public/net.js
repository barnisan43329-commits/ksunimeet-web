/* KsuNiMeet — сеть с приоритетом России.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. У проекта ровно одна внешняя зависимость — Supabase, а он
 * стоит за Cloudflare. Российские провайдеры (ТСПУ) с июня 2025 режут именно
 * сеть Cloudflare: соединение открывается, а через ~16 КБ обрывается. Свои
 * статические файлы этой участи не имеют — им не мешает никто, — но каждый
 * запрос к базе идёт по этому тонкому месту. И ещё: GitHub доступен в РФ
 * нестабильно (по OONI 10–16 % неудачных подключений).
 *
 * Что здесь есть, по порядку важности:
 *
 *   1. НИ ОДИН ЗАПРОС НЕ ВИСИТ. У каждого есть дедлайн. Обрыв на середине
 *      ответа превращается в понятную ошибку, а не в белый экран: раньше
 *      `sb.auth.getSession()` без сети просто не отвечал никогда, и человек
 *      видел пустую страницу вместо «нет связи, повторить».
 *   2. ПОВТОР С ЗАДЕРЖКОЙ. Оборванный 16-килобайтный ответ почти всегда
 *      проходит со второго раза. GET/HEAD/PUT (безопасные к повтору)
 *      повторяются и при сетевой ошибке; POST/PATCH/DELETE — только когда
 *      сервер уже ответил 408/429/5xx: повторить INSERT, который мог
 *      примениться, значит отправить сообщение дважды.
 *   3. ЗЕРКАЛА, ПРИЧЕМ РОССИЯ ВПЕРЁД. Список задаётся в `window.KSU_MIRRORS`
 *      (см. mirror.js рядом). Если браузер русский, а зеркало отвечает — идём
 *      на зеркало; если текущий адрес вообще не отвечает, а зеркало живо —
 *      переходим на него сами, один раз за сессию, без петли.
 *   4. ЧЕСТНЫЙ СТАТУС. Полоска сверху говорит, что происходит, и даёт
 *      «Повторить». Никаких молчаливых отказов.
 *   5. САМОПРОВЕРКА `?diag`: показывает, что именно недоступно у ЭТОГО
 *      человека — адрес, база, websocket — с временами. Это то, что просят
 *      прислать скриншотом, вместо «у меня не работает».
 *
 * ПРО СЛОВО «ПРИОРИТЕТ». Приоритет тут не про политику, а про порядок
 * попыток: сначала адрес, который в России открывается быстрее и надёжнее,
 * потом остальные. Тяжёлые ответы режутся на части (`limit` в запросах), а
 * не тянутся одним куском через режущий фильтр.
 *
 * Совместимость: Android 8 (WebView ~Chrome 60) — поэтому var, никаких стрелок,
 * шаблонных строк и async/await. AbortController есть не везде — если его нет,
 * дедлайн всё равно работает (гонка с таймером), просто запрос не отменяется.
 */
(function () {
  'use strict';

  if (window.KSU_NET) return;

  var cfg = window.KSU_CONFIG || {};
  var SB = cfg.supabaseUrl || '';

  var GET_TIMEOUT = 12000;      // обычный запрос
  var UP_TIMEOUT = 60000;       // загрузка фильма частями — ей нужен запас
  var PROBE_TIMEOUT = 3000;     // проба зеркала: дольше ждать незачем
  var SLOW_MS = 2500;           // адрес, который отвечает дольше, — «медленный»
  var OFFLINE_AFTER = 2;        // столько отказов подряд = «нет связи»

  /* ================= состояние ================= */

  var st = {
    state: 'unknown',    // ok | slow | offline | unknown
    fails: 0,
    ok: 0,
    rtt: null,           // мс последнего успешного ответа
    lastError: '',
    realtime: 'unknown', // окно для app.js/watch.js: unknown | up | down
    origin: null,        // выбранное зеркало (или текущий адрес)
    switched: false,
    calls: 0,            // сколько запросов прошло через этот слой (для ?diag)
    retries: 0           // сколько из них потребовало повтора
  };

  var watchers = [];
  var queue = Promise.resolve();   // сериализация одинаковых запросов не нужна,
                                   // но отчёт о состоянии должен быть по порядку

  function nowMs() { return new Date().getTime(); }

  function assign(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function jitter(ms) { return ms + Math.floor(Math.random() * Math.max(1, ms * 0.4)); }

  function lang() {
    var l = window.KSU_NET_LANG;
    if (l === 'ru' || l === 'en') return l;
    if (document.documentElement && document.documentElement.lang === 'en') return 'en';
    return 'ru';
  }

  var T = {
    ru: {
      offline: 'Нет связи с сервером. Пробуем ещё…',
      retry: 'Повторить',
      slow: 'Медленная связь — сообщения могут приходить с задержкой.',
      mirror: 'Открыть зеркало',
      checking: 'Проверяем связь…',
      diag: 'Самопроверка',
      app: 'Сайт',
      db: 'База',
      rt: 'Живые обновления',
      dns_ok: 'отвечает',
      dns_no: 'не отвечает',
      mode: 'Режим',
      ru_mode: 'российский (лёгкий)',
      normal: 'обычный',
      copy: 'Скопировать отчёт',
      copied: 'Отчёт скопирован'
    },
    en: {
      offline: 'No connection to the server. Retrying…',
      retry: 'Retry',
      slow: 'Slow connection — messages may arrive late.',
      mirror: 'Open the mirror',
      checking: 'Checking the connection…',
      diag: 'Self-check',
      app: 'Site',
      db: 'Database',
      rt: 'Live updates',
      dns_ok: 'answers',
      dns_no: 'no answer',
      mode: 'Mode',
      ru_mode: 'Russian (light)',
      normal: 'normal',
      copy: 'Copy report',
      copied: 'Report copied'
    }
  };

  function t(k) { return (T[lang()] || T.ru)[k] || k; }

  /* ================= русский режим =================
   * Не «гео-блок», а размер запросов. Там, где канал рвётся на 16 КБ, важно
   * тянуть понемногу и часто. Язык ставим первым признаком, часовой пояс —
   * вторым (русский интерфейс с немецким поясом — это турист, ему не нужно).
   */
  var ru = (function () {
    var langs = [];
    try {
      if (navigator.languages && navigator.languages.length) langs = navigator.languages;
      else if (navigator.language) langs = [navigator.language];
    } catch (e) {}
    for (var i = 0; i < langs.length; i++) {
      if (String(langs[i] || '').toLowerCase().indexOf('ru') === 0) return true;
    }
    try {
      var tz = (window.Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
      if (/Moscow|Volgograd|Samara|Yekaterinburg|Omsk|Krasnoyarsk|Novosibirsk|Irkutsk|Yakutsk|Vladivostok|Magadan|Sakhalin|Kamchatka|Kaliningrad|Kirov|Saratov|Astrakhan|Ulyanovsk|Chita|Tomsk|Barnaul|Novokuznetsk|Srednekolymsk|Ust-Nera/.
        test(String(tz))) return true;
    } catch (e) {}
    return false;
  })();

  /* ================= отчёт о состоянии ================= */

  function fire() {
    for (var i = 0; i < watchers.length; i++) {
      try { watchers[i](state()); } catch (e) {}
    }
    paint();
  }

  function markOk(ms) {
    st.ok++;
    st.fails = 0;
    st.rtt = ms;
    st.lastError = '';
    st.state = ms > SLOW_MS ? 'slow' : 'ok';
    fire();
  }

  function markFail(err) {
    st.fails++;
    st.lastError = (err && (err.message || err.name)) || 'error';
    if (st.fails >= OFFLINE_AFTER) st.state = 'offline';
    else if (st.state === 'ok' || st.state === 'unknown') st.state = 'slow';
    fire();
  }

  function state() {
    return {
      state: st.state, rtt: st.rtt, fails: st.fails, ok: st.ok,
      error: st.lastError, realtime: st.realtime, ru: ru, calls: st.calls, retries: st.retries,
      origin: st.origin || (location.origin + basePath())
    };
  }

  function onStatus(cb) {
    if (typeof cb === 'function') { watchers.push(cb); try { cb(state()); } catch (e) {} }
    return function () {
      for (var i = 0; i < watchers.length; i++) if (watchers[i] === cb) watchers.splice(i, 1);
    };
  }

  /* ================= запрос с дедлайном ================= */

  var TIMEOUT = { timeout: true };

  function one(url, init, ms) {
    var ctl = null;
    var opt = init || {};
    // Если вызывающий сам принёс signal (так делает supabase-js, когда умеет
    // отменять запрос), не подменяем его: иначе его отмена перестанет работать.
    // Дедлайн в этом случае всё равно срабатывает — гонкой с таймером.
    if (!opt.signal && typeof AbortController === 'function') {
      try { ctl = new AbortController(); } catch (e) { ctl = null; }
      if (ctl) opt = assign(opt, { signal: ctl.signal });
    }

    var timer = null;
    var race = [
      Promise.resolve().then(function () { return fetch(url, opt); })
        .then(function (r) { return { res: r }; },
              function (e) { return { err: e }; }),
      new Promise(function (resolve) {
        timer = setTimeout(function () {
          // Отменяем сам сокет: тогда и keep-alive-соединение не висит зря.
          if (ctl) { try { ctl.abort(); } catch (e) {} }
          resolve(TIMEOUT);
        }, ms);
      })
    ];

    return Promise.race(race).then(function (out) {
      if (timer) clearTimeout(timer);
      if (out === TIMEOUT) return { err: { name: 'TimeoutError', message: 'timeout ' + ms + 'ms' } };
      return out;
    });
  }

  // Повторять ли запрос при сетевой ошибке. GET/HEAD/PUT безопасны к повтору;
  // POST/PATCH/DELETE — нет: INSERT мог примениться до обрыва ответа.
  function repeatable(method) {
    var m = String(method || 'GET').toUpperCase();
    return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || m === 'PUT';
  }

  // Ответ сервера, при котором повтор осмысленен (он точно НЕ применился
  // полностью): 408, 425, 429, 500, 502, 503, 504.
  function retriableCode(c) {
    return c === 408 || c === 425 || c === 429 || c === 500 ||
           c === 502 || c === 503 || c === 504;
  }

  function isUpload(init) {
    var b = init && init.body;
    if (!b) return false;
    if (typeof FormData !== 'undefined' && b instanceof FormData) return true;
    if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
    if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return true;
    return false;
  }

  /* net(url, init) — обычный fetch, только с дедлайном и повтором.
   * Принимает и Request-подобный первый аргумент: supabase-js всегда передаёт
   * строку, но пусть не сломается, если однажды передаст Request. */
  function net(url, init) {
    var opt = init || {};
    var method = opt.method || 'GET';
    var ms = Number(opt.ksuTimeout) || (isUpload(opt) ? UP_TIMEOUT : GET_TIMEOUT);
    var tries = Number(opt.ksuTries) || 3;
    var tryNo = 0;
    st.calls++;

    function attempt() {
      tryNo++;
      if (tryNo > 1) st.retries++;
      var started = nowMs();
      return one(url, opt, ms).then(function (out) {
        var spent = nowMs() - started;
        if (out.res) {
          if (!out.res.ok && retriableCode(out.res.status) && tryNo < tries) {
            return sleep(jitter(400 * tryNo)).then(attempt);
          }
          markOk(spent);
          return out.res;
        }
        // Сеть оборвалась или дедлайн. Повторяем, если запрос безопасен к
        // повтору, либо если сервер ответил ошибкой (см. retriableCode выше —
        // сюда попадаем только на сетевой ошибке).
        if (tryNo < tries && repeatable(method)) {
          return sleep(jitter(400 * tryNo)).then(attempt);
        }
        markFail(out.err);
        throw out.err;
      });
    }

    return attempt();
  }

  net.json = function (url, init) {
    return net(url, init).then(function (r) { return r.json(); });
  };

  /* Дедлайн для чужого промиса (например, sb.auth.getSession(), у которого
   * своего дедлайна нет). Возвращает объект-маркер, чтобы вызывающий код
   * различил «пришёл ответ» и «истекло время», а не гадал по undefined. */
  net.deadline = function (promise, ms) {
    var timer = null;
    return Promise.race([
      Promise.resolve(promise).then(function (v) { return { ok: true, value: v }; },
                                    function (e) { return { ok: false, error: e }; }),
      new Promise(function (resolve) {
        timer = setTimeout(function () { resolve({ timedOut: true }); }, ms || GET_TIMEOUT);
      })
    ]).then(function (out) {
      if (timer) clearTimeout(timer);
      return out;
    });
  };

  /* ================= доступность адресов ================= */

  function basePath() {
    var p = location.pathname || '/';
    if (p.charAt(p.length - 1) !== '/') p = p.replace(/[^/]*$/, '');
    return p;
  }

  function sameOrigin() {
    return location.origin + basePath();
  }

  /* Проба адреса.
   *
   * Нужен не «сервер отвечает», а «здесь лежит ИМЕННО это приложение».
   * На своём же домене когда-то стояла другая версия (PHP-сайт), и она тоже
   * ответила бы 200 на manifest.json — уехать туда значило бы показать чужой
   * интерфейс и потерять вход. Поэтому берём ping.js со случайным token в
   * адресе: он возвращает ровно этот token, а угадать его нельзя.
   *
   * <script> вместо fetch — нарочно: скрипту не нужен
   * Access-Control-Allow-Origin, поэтому зеркалу достаточно просто отдавать
   * файл. Плюс так проба работает и в старом WebView, где CORS-запрос к чужому
   * хосту мог упасть до того, как станет ясно, жив адрес или нет. */
  function probe(origin, ms) {
    return new Promise(function (resolve) {
      var started = nowMs();
      var settled = false;
      var token = 'ksu-' + nowMs() + '-' + Math.floor(Math.random() * 1e9);
      var s = document.createElement('script');

      function finish(ok, why) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          s.onload = null; s.onerror = null;
          if (s.parentNode) s.parentNode.removeChild(s);
        } catch (e) {}
        try { window.KSU_MIRROR_TAG = ''; } catch (e) {}
        resolve(ok
          ? { origin: origin, ok: true, ms: nowMs() - started, status: 200 }
          : { origin: origin, ok: false, ms: null, why: why });
      }

      var timer = setTimeout(function () { finish(false, 'timeout ' + (ms || PROBE_TIMEOUT) + 'ms'); }, ms || PROBE_TIMEOUT);
      s.onload = function () {
        if (window.KSU_MIRROR_TAG === token) finish(true, '');
        else finish(false, 'another site at this address');
      };
      s.onerror = function () { finish(false, 'no answer'); };
      s.async = true;
      try { window.KSU_MIRROR_TAG = ''; } catch (e) {}
      s.src = origin.replace(/\/+$/, '') + '/ping.js?token=' + encodeURIComponent(token) + '&ksu=' + nowMs();
      (document.head || document.documentElement).appendChild(s);
    });
  }

  /* Список адресов — в порядке предпочтения. Первым всегда текущий: на нём
   * человек уже находится, и без причины уводить его нельзя. */
  function origins() {
    var list = [sameOrigin()];
    var mir = window.KSU_MIRRORS || [];
    for (var i = 0; i < mir.length; i++) {
      var m = String(mir[i] || '').replace(/\/+$/, '') + '/';
      if (m && m !== list[0] && list.indexOf(m) < 0) list.push(m);
    }
    return list;
  }

  /* Выбор адреса. Ждём все пробы, но не дольше PROBE_TIMEOUT: если зеркала
   * молчат, остаёмся где стоим. Возвращает { origin, why, table }. */
  function choose() {
    var list = origins();
    var jobs = [];
    for (var i = 0; i < list.length; i++) jobs.push(probe(list[i]));

    return Promise.all(jobs).then(function (rows) {
      var alive = [];
      for (var i = 0; i < rows.length; i++) if (rows[i].ok) alive.push(rows[i]);
      alive.sort(function (a, b) { return a.ms - b.ms; });

      var me = rows[0];
      var best = alive.length ? alive[0] : null;
      var pick = me, why = 'stay';

      if (!me.ok && best) { pick = best; why = 'current-dead'; }
      else if (me.ok && best && best.origin !== me.origin) {
        // Зеркало быстрее. Переходим на него, если браузер русский (приоритет
        // России) или если своё отвечает заметно медленнее.
        if (ru) { pick = best; why = 'ru-first'; }
        else if (best.ms * 1.5 < me.ms) { pick = best; why = 'faster'; }
      }
      st.origin = pick.origin;
      return { origin: pick.origin, why: why, mine: me, table: rows };
    });
  }

  /* Один автоматический переход за сессию вкладки — защита от петли, если
   * зеркало считает своим лучшим нас, а мы его. */
  function switchedAlready() {
    try { return sessionStorage.getItem('ksu-origin-switch') === '1'; } catch (e) { return false; }
  }
  function markSwitched() {
    try { sessionStorage.setItem('ksu-origin-switch', '1'); } catch (e) {}
  }

  /* Автопереход. Вызывается на старте — без блокировки отрисовки: пока она
   * идёт, страница уже нарисована. Если переходить некуда — молча ничего. */
  function autostart() {
    if (origins().length < 2) return Promise.resolve({ origin: sameOrigin(), why: 'single' });
    if (switchedAlready()) return Promise.resolve({ origin: sameOrigin(), why: 'already-switched' });
    // Уважаем выбор человека: ?stay=1 — не переходить никуда.
    if (/[?&]stay=1\b/.test(location.search)) return Promise.resolve({ origin: sameOrigin(), why: 'stay-asked' });
    return choose().then(function (r) {
      if (r.origin !== sameOrigin()) {
        markSwitched();
        st.switched = true;
        var keep = location.hash || '';
        location.replace(r.origin + '?to=mirror' + keep);
      }
      return r;
    });
  }

  /* ================= полоска статуса ================= */

  var bar = null, barText = null, barBtn = null, painted = '';

  function paint() {
    if (!bar) {
      if (!document.body) return;
      bar = document.createElement('div');
      bar.id = 'ksu-net-bar';
      bar.setAttribute('role', 'status');
      bar.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:2147483000;display:none;' +
        'align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;' +
        'font:600 13.5px/1.3 -apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;' +
        'color:#fff;background:#bf4d43;box-shadow:0 2px 12px rgba(31,30,29,.18)';
      barText = document.createElement('span');
      barText.style.cssText = 'flex:1;min-width:0';
      barBtn = document.createElement('button');
      barBtn.type = 'button';
      barBtn.style.cssText =
        'border:0;border-radius:9px;padding:7px 12px;font:inherit;font-weight:700;' +
        'background:rgba(255,255,255,.18);color:#fff;flex:none';
      barBtn.onclick = function () { retry(); };
      bar.appendChild(barText);
      bar.appendChild(barBtn);
      document.body.appendChild(bar);
    }

    var s = state();
    var key = s.state + '|' + lang();
    if (key === painted) return;
    painted = key;

    if (s.state === 'offline') {
      bar.style.display = 'flex';
      barText.textContent = t('offline');
      barBtn.textContent = t('retry');
    } else if (s.state === 'slow') {
      bar.style.display = 'flex';
      bar.style.background = '#a8792b';
      barText.textContent = t('slow');
      barBtn.textContent = t('retry');
    } else {
      bar.style.display = 'none';
      bar.style.background = '#bf4d43';
    }
  }

  /* Повтор: сначала прогоняем лёгкую пробу (адрес и база), потом просим
   * страницу перечитать данные. Наверх отдаём событие, чтобы приложение
   * само решало, что перечитывать. */
  function retry() {
    painted = '';
    st.state = 'unknown';
    paint();
    return net.probe().then(function (r) {
      // Итог пробы — это и есть ответ на вопрос «есть ли связь»: сайт отвечает
      // → мы на связи; не отвечает → полоска остаётся и объясняет, что именно.
      var app = r.rows.app, db = r.rows.db;
      if (app && app.ok) {
        st.fails = 0;
        st.rtt = app.ms;
        st.lastError = '';
        st.state = (db && db.ok) ? (app.ms > SLOW_MS ? 'slow' : 'ok') : 'slow';
      } else {
        st.fails = Math.max(st.fails, OFFLINE_AFTER);
        st.lastError = (app && app.why) || 'no answer';
        st.state = 'offline';
      }
      fire();
      try { window.dispatchEvent(new CustomEvent('ksu-net-retry')); } catch (e) {}
      return r;
    }, function () { fire(); });
  }

  /* ================= простые счётчики для интерфейса ================= */

  net.note = function (what, val) {
    if (what === 'realtime') { st.realtime = val; fire(); }
  };

  /* ================= самопроверка ?diag =================
   * Отвечает на «что именно у тебя не открывается» без догадок: адрес, база,
   * живые обновления — по времени на каждый. Именно это просят прислать
   * скриншотом вместо «не работает».
   */

  function probeApp() {
    return probe(sameOrigin());
  }

  function probeDb() {
    if (!SB) return Promise.resolve({ name: 'db', ok: false, why: 'config.js пуст' });
    var started = nowMs();
    return one(SB + '/auth/v1/health',
               { method: 'GET', cache: 'no-store', headers: { apikey: cfg.supabaseAnonKey || '' } },
               PROBE_TIMEOUT + 2000).then(function (out) {
      if (out.res) return { name: 'db', ok: true, ms: nowMs() - started, status: out.res.status };
      return { name: 'db', ok: false, why: (out.err && out.err.message) || 'no answer' };
    });
  }

  function probeRt() {
    if (!SB) return Promise.resolve({ name: 'rt', ok: false, why: 'config.js пуст' });
    return new Promise(function (resolve) {
      var settled = false, ws = null, timer = null;
      function done(ok, why) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) {}
        resolve({ name: 'rt', ok: ok, why: why });
      }
      timer = setTimeout(function () { done(false, 'timeout ' + PROBE_TIMEOUT + 'ms'); }, PROBE_TIMEOUT);
      try {
        var url = SB.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' +
                  encodeURIComponent(cfg.supabaseAnonKey || '') + '&vsn=1.0.0';
        ws = new WebSocket(url);
        ws.onopen = function () { done(true, ''); };
        ws.onerror = function () { done(false, 'websocket error'); };
        ws.onclose = function () {
          if (!settled) done(false, 'closed'); 
        };
      } catch (e) { done(false, String(e.message || e)); }
    });
  }

  /* Полная проверка: адрес + база + живые обновления, параллельно. */
  net.probe = function () {
    return Promise.all([probeApp(), probeDb(), probeRt()]).then(function (rows) {
      var out = { at: new Date().toISOString(), ru: ru, rows: {}, state: state() };
      for (var i = 0; i < rows.length; i++) out.rows[rows[i].name || 'app'] = rows[i];
      return out;
    });
  };

  function line(r) { return r && r.ok ? (r.ms != null ? r.ms + ' ms' : 'ok') : ('— ' + ((r && r.why) || 'нет')); }

  net.diag = function () {
    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483001;background:#fff;' +
      'border:1px solid #e8e4d9;border-radius:16px;padding:14px;box-shadow:0 10px 40px rgba(31,30,29,.20);' +
      'font:14px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,Arial,sans-serif;color:#1f1e1d;max-width:520px';
    wrap.textContent = t('checking');
    document.body.appendChild(wrap);

    net.probe().then(function (r) {
      var app = r.rows.app, db = r.rows.db, rt = r.rows.rt;
      var html = '<div style="font-weight:700;font-size:16px;margin-bottom:8px">' + t('diag') + '</div>' +
        '<div>' + t('app') + ': <b>' + line(app) + '</b></div>' +
        '<div>' + t('db') + ': <b>' + line(db) + '</b></div>' +
        '<div>' + t('rt') + ': <b>' + line(rt) + '</b></div>' +
        '<div style="margin-top:6px;color:#5f5e59">' + t('mode') + ': ' + (ru ? t('ru_mode') : t('normal')) + '</div>' +
        '<div style="margin-top:4px;color:#5f5e59;font-size:12.5px;word-break:break-all">' +
          'origin ' + location.host + ' · supabase ' + (SB ? SB.replace(/^https?:\/\//, '') : '—') + '</div>';

      wrap.innerHTML = html;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText =
        'margin-top:12px;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:700;' +
        'background:#bd5230;color:#fff';
      btn.textContent = t('copy');
      btn.onclick = function () {
        var text = 'KsuNiMeet diag ' + r.at + '\n' +
          'origin: ' + location.href + '\n' +
          'app: ' + line(app) + '\ndb: ' + line(db) + '\nrt: ' + line(rt) + '\n' +
          'ru: ' + ru + '\nua: ' + navigator.userAgent;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
          else {
            var ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
          }
          btn.textContent = t('copied');
        } catch (e) {}
      };
      wrap.appendChild(btn);
    });
    return wrap;
  };

  /* ================= экспорт ================= */

  /* ВАЖНО: сюда приходят и supabase-js, и страницы — через `KSU_NET.fetch`.
   * (В первой версии этого файла такого имени не было, и supabase-js молча
   * брал глобальный fetch: приложение работало, но без дедлайнов. Имя
   * `fetch` есть ровно для того, чтобы подмена была явной и проверяемой:
   * счётчик `calls` в ?diag сразу показывает, идут ли запросы через слой.) */
  net.fetch = net;
  net.state = state;
  net.onStatus = onStatus;
  net.retry = retry;
  net.choose = choose;
  net.probeOrigin = probe;
  net.origins = origins;
  net.nowMs = nowMs;
  net.timeout = function () { return { timedOut: true }; };
  net.ru = ru;

  window.KSU_NET = net;

  /* Порядок пробуждения. Зеркала выбираем после отрисовки: уводить человека
   * на другой адрес раньше, чем он увидел интерфейс, — это мигание. */
  function boot() {
    paint();
    autostart().then(function () { fire(); }, function () { fire(); });
    if (/[?&]diag\b/.test(location.search)) net.diag();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
