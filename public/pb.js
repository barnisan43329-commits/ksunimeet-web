/* KsuNiMeet — PocketBase вместо Supabase, не трогая приложение.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. app.js, watch.js и call.js написаны против supabase-js:
 * `sb.from('messages').select(...).eq(...).order(...)`, `sb.channel(...).on(
 * 'broadcast'|'presence', ...)`, `sb.auth.signInWithPassword(...)`,
 * `sb.storage.from(...).upload(...)`. Переписывать три отлаженных файла под
 * другой бэкенд — это заново ломать то, что уже работает в России (net.js,
 * зеркала, дедлайны, оптимистичная отправка). Поэтому здесь ровно тот же
 * интерфейс, только собранный на PocketBase:
 *
 *   форма ответа   { data, error }            — как у supabase-js
 *   выборка        from().select().eq()…      — переводится в фильтр PocketBase
 *   живые события  channel().on('broadcast') — через SSE на /api/realtime
 *   файлы          storage.from().upload()    — файл-поле коллекции films
 *
 * ЧЕГО У POCKETBASE НЕТ И ЧЕМ ЭТО ЗАМЕНЕНО (честно, чтобы не выглядело магией):
 *
 *   postgres_changes  — не нужен: приложение им не пользуется (на Supabase он
 *                       всё равно молчал под RLS, поэтому «живость» держится
 *                       на broadcast-пинге). Здесь пинг идёт записью в `bus`.
 *   broadcast         — записи в `bus` + SSE на коллекцию. Все подписчики
 *                       видят все события, нужный канал выбирается по `topic`.
 *   presence          — записи в `presence` с сердцебиением (PocketBase не
 *                       сообщает «подписчик отключился», поэтому выход виден
 *                       через один тик уборки).
 *   storage bucket    — коллекция `films`: файл — это поле записи.
 *   autoincrement id  — поле `seq`, которое выдаёт серверный хук. Приложению
 *                       это отдаётся как `id`, и вся его логика «что новее»
 *                       продолжает работать (см. PB_FIELD ниже).
 *
 * ПРО СТАРЫЕ БРАУЗЕРЫ. Целевой WebView — Android 8 (Chrome ~60): var, никаких
 * стрелок, шаблонных строк и async/await. Поток SSE читаем через fetch, а не
 * EventSource: EventSource не умеет заголовков, а подписка требует
 * Authorization (проверено на живом сервере).
 */
(function () {
  'use strict';

  if (window.KSU_PB) return;

  var CFG = window.KSU_CONFIG || {};
  // Адрес бэкенда. Хвостовой слэш убираем, чтобы не собрать «//api».
  var BASE = String(CFG.pbUrl || '').replace(/\/+$/, '');
  var AUTH_KEY = 'ksu-pb-auth';

  var READ_TIMEOUT = 15000;    // обычный запрос
  var FILE_TIMEOUT = 300000;   // часть фильма: 45 МБ могут ехать долго

  /* =====================================================================
   * Соответствие имён полей
   * ===================================================================== */
  /* Единственное место, где имена расходятся. Supabase отдавал у messages
   * целочисленный autoincrement `id`, и приложение опирается на это: сортирует
   * по нему («по времени»), спрашивает «что новее maxId» через gt('id', …),
   * сравнивает Number(m.id), а также использует id как ключ в списке
   * показанного. В PocketBase id — случайная строка, поэтому сервер выдаёт
   * монотонный `seq`, а здесь он отдаётся приложению как `id`.
   *
   * У contacts/calls/rooms/profiles расхождений нет: имена полей в миграции
   * названы так же, как их ждёт браузер.
   */
  var PB_FIELD = { messages: { id: 'seq' } };

  function pbCol(table, col) {
    var m = PB_FIELD[table];
    return (m && m[col]) || col;
  }

  /* =====================================================================
   * Мелочи
   * ===================================================================== */

  function lang() {
    if (window.KSU_NET_LANG === 'en') return 'en';
    try {
      if (document.documentElement && document.documentElement.lang === 'en') return 'en';
    } catch (e) {}
    return 'ru';
  }

  function escQ(s) {
    // Кавычка внутри значения сломала бы фильтр PocketBase.
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isFormData(v) {
    return typeof FormData !== 'undefined' && v instanceof FormData;
  }

  function obj(extra) {
    var o = {};
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }

  /* =====================================================================
   * Сессия
   * ===================================================================== */

  var session = null;
  try {
    var raw = localStorage.getItem(AUTH_KEY);
    if (raw) session = JSON.parse(raw);
  } catch (e) {
    session = null;
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(AUTH_KEY, JSON.stringify(s));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
  }

  function token() {
    return (session && session.access_token) || '';
  }

  function myId() {
    return (session && session.user && session.user.id) || '';
  }

  function toSession(tokenValue, record) {
    return {
      access_token: tokenValue,
      refresh_token: '',
      user: { id: record.id, username: record.username, phone: record.phone }
    };
  }

  /* Срок жизни токена из самого JWT. Нужен, чтобы продлить заранее: PocketBase
   * по умолчанию выдаёт его на 5 суток, и молча истёкшая сессия выглядела бы
   * для человека как «вход перестал работать». */
  function tokenExpiresAt(tok) {
    try {
      var parts = String(tok).split('.');
      if (parts.length < 2) return 0;
      var p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var json = JSON.parse(atob(p));
      return (Number(json.exp) || 0) * 1000;
    } catch (e) {
      return 0;
    }
  }

  /* =====================================================================
   * Транспорт
   * ===================================================================== */
  /* Запросы идут через net.js, когда он есть: у каждого дедлайн и повтор.
   * На канале, который рвётся, это разница между «пришло со второго раза» и
   * «нет связи». Для потока SSE net.js не годится — у него дедлайн, а поток
   * живёт часами; поэтому там обычный fetch (см. hub ниже). */
  function req(method, path, body, opts) {
    var o = opts || {};
    var init = { method: method, headers: {} };
    var h = init.headers;

    if (token()) h.Authorization = token();
    if (body !== undefined && body !== null) {
      if (isFormData(body)) {
        init.body = body; // Content-Type с boundary ставит сам fetch
      } else {
        h['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    init.ksuTimeout = o.timeout || READ_TIMEOUT;
    init.ksuTries = o.tries || 3;
    // Список с фильтром нельзя кэшировать: иначе «прочитано» и новые
    // сообщения приезжали бы из кэша браузера.
    init.cache = 'no-store';

    var f = (window.KSU_NET && window.KSU_NET.fetch) || window.fetch;
    return f(BASE + path, init).then(
      function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = text;
            }
          }
          if (res.ok) return { data: data, error: null, status: res.status };
          return { data: null, error: pbError(res.status, data), status: res.status };
        });
      },
      function (err) {
        return { data: null, error: err, status: 0 };
      }
    );
  }

  function pbError(status, body) {
    var msg = '';
    if (body && typeof body === 'object') {
      msg = body.message || '';
      if (!msg && body.data && typeof body.data === 'object') {
        for (var k in body.data) {
          if (body.data[k] && body.data[k].message) {
            msg = body.data[k].message;
            break;
          }
        }
      }
    } else if (typeof body === 'string') {
      msg = body;
    }
    var e = new Error(msg || ('HTTP ' + status));
    e.status = status;
    e.details = body;
    return e;
  }

  /* =====================================================================
   * Фильтры: синтаксис PostgREST -> синтаксис PocketBase
   * ===================================================================== */

  function literal(col, value) {
    if (value === null || value === undefined) return col + ' = null';
    if (typeof value === 'boolean') return col + ' = ' + (value ? 'true' : 'false');
    if (isNum(value)) return col + ' = ' + value;
    return col + ' = "' + escQ(value) + '"';
  }

  var OPS = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<='
  };

  /* Одна ветка PostgREST-выражения: col.op.value (value может быть пустым,
   * например username.is.null). */
  function orTerm(table, text) {
    var m = /^([A-Za-z0-9_]+)\.([a-zA-Z_]+)\.?(.*)$/.exec(String(text).trim());
    if (!m) return '';
    var col = pbCol(table, m[1]);
    var op = m[2];
    var val = m[3];

    if (op === 'is') {
      return val === 'null' ? col + ' = null' : col + ' = "' + escQ(val) + '"';
    }
    if (op === 'ilike' || op === 'like') {
      // PostgREST: `*` — это `%`. Приложение всегда обрамляет с двух сторон,
      // поэтому «содержит» (в PocketBase это `~`) — точный эквивалент.
      return col + ' ~ "' + escQ(String(val).replace(/\*/g, '')) + '"';
    }
    if (OPS[op]) {
      if (val === 'null') return col + ' ' + OPS[op] + ' null';
      if (/^-?[0-9]+(\.[0-9]+)?$/.test(val) && !/^0[0-9]/.test(val)) {
        // Числа оставляем без кавычек: seq > 5, а не seq > "5".
        return col + ' ' + OPS[op] + ' ' + val;
      }
      return col + ' ' + OPS[op] + ' "' + escQ(val) + '"';
    }
    return '';
  }

  function splitTop(text) {
    var out = [];
    var depth = 0;
    var cur = '';
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* =====================================================================
   * Разбор select(): что просили и какие связи тянуть
   * ===================================================================== */
  /* Приложение просит одну связь в стиле PostgREST:
   *   peer:profiles!contacts_peer_id_fkey(id,username,phone)
   * Имя ограничения (!contacts_peer_id_fkey) — это деталь Supabase, здесь оно
   * не нужно. Связь в PocketBase называется по полю-отношению, а оно у нас
   * всегда <alias>_id, поэтому `peer` -> expand=peer_id. */
  function parseSelect(text) {
    var t = String(text || '').trim();
    if (!t || t === '*') return { all: true, entries: [] };
    var parts = splitTop(t);
    var entries = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var ci = p.indexOf(':');
      if (ci > 0) {
        var alias = p.slice(0, ci).trim();
        var rest = p.slice(ci + 1).trim();
        var sub = null;
        var open = rest.indexOf('(');
        if (open >= 0 && rest.charAt(rest.length - 1) === ')') {
          sub = rest.slice(open + 1, rest.length - 1);
          rest = rest.slice(0, open);
        }
        // Отбрасываем `!имя_ограничения`.
        var bang = rest.indexOf('!');
        if (bang >= 0) rest = rest.slice(0, bang);
        entries.push({ alias: alias, rel: alias + '_id', sub: parseSelect(sub) });
      } else {
        entries.push({ name: p });
      }
    }
    return { all: false, entries: entries };
  }

  function expandList(spec) {
    if (!spec || spec.all) return [];
    var out = [];
    for (var i = 0; i < spec.entries.length; i++) {
      if (spec.entries[i].rel) out.push(spec.entries[i].rel);
    }
    return out;
  }

  function valueOf(table, rec, name) {
    if (name === 'id' && table === 'messages') {
      return rec.seq === undefined || rec.seq === null ? null : String(rec.seq);
    }
    var v = rec[name];
    return v === undefined ? null : v;
  }

  function projectRow(table, rec, spec) {
    if (!rec) return null;
    if (!spec || spec.all) {
      var full = obj(rec);
      if (table === 'messages') full.id = valueOf(table, rec, 'id');
      return full;
    }
    var row = {};
    for (var i = 0; i < spec.entries.length; i++) {
      var e = spec.entries[i];
      if (e.rel) {
        var ex = rec.expand && rec.expand[e.rel];
        row[e.alias] = ex ? projectRow('', ex, e.sub) : null;
      } else {
        row[e.name] = valueOf(table, rec, e.name);
      }
    }
    return row;
  }

  /* =====================================================================
   * Конструктор запроса
   * ===================================================================== */

  function Builder(table) {
    this.table = table;
    this.action = 'select';
    this.spec = null;
    this.filters = [];
    this.sorts = [];
    this.perPage = 60;
    // ИМЯ ЭТОГО ПОЛЯ ВАЖНО. Оно не может называться `single`: конструктор
    // задал бы собственное свойство экземпляра и ЗАТЕНИЛ бы метод
    // `Builder.prototype.single`, после чего `.select(...).single()` падал бы
    // с «is not a function». Именно это и случилось в первом заходе, причём
    // молча для глаза: сообщение всё равно рисовалось оптимистично, а запрос
    // не уходил вовсе. Поэтому `rowMode`.
    this.rowMode = null;
    this.body = null;
  }

  Builder.prototype.select = function (text) {
    this.spec = parseSelect(text);
    return this;
  };

  Builder.prototype.eq = function (col, v) {
    this.filters.push(literal(pbCol(this.table, col), v));
    return this;
  };
  Builder.prototype.neq = function (col, v) {
    if (v === null || v === undefined) {
      this.filters.push(pbCol(this.table, col) + ' != null');
      return this;
    }
    this.filters.push(pbCol(this.table, col) + ' != "' + escQ(v) + '"');
    return this;
  };
  Builder.prototype.gt = function (col, v) {
    this.filters.push(cmp(this.table, col, '>', v));
    return this;
  };
  Builder.prototype.gte = function (col, v) {
    this.filters.push(cmp(this.table, col, '>=', v));
    return this;
  };
  Builder.prototype.lt = function (col, v) {
    this.filters.push(cmp(this.table, col, '<', v));
    return this;
  };
  Builder.prototype.lte = function (col, v) {
    this.filters.push(cmp(this.table, col, '<=', v));
    return this;
  };

  function cmp(table, col, op, v) {
    var c = pbCol(table, col);
    if (v === null || v === undefined) return c + ' ' + op + ' null';
    if (isNum(v)) return c + ' ' + op + ' ' + v;
    return c + ' ' + op + ' "' + escQ(v) + '"';
  }

  Builder.prototype.is = function (col, v) {
    var c = pbCol(this.table, col);
    this.filters.push(v === null ? c + ' = null' : c + ' = "' + escQ(v) + '"');
    return this;
  };

  Builder.prototype.in = function (col, list) {
    var c = pbCol(this.table, col);
    var arr = list || [];
    var parts = [];
    for (var i = 0; i < arr.length; i++) {
      parts.push(isNum(arr[i]) ? c + ' = ' + arr[i] : c + ' = "' + escQ(arr[i]) + '"');
    }
    this.filters.push(parts.length ? '(' + parts.join(' || ') + ')' : c + ' = null');
    return this;
  };

  /* .or('a.eq.1,b.eq.2') — ветки объединяются через ||, и группа всегда в
   * скобках, иначе при склейке с && получился бы неверный приоритет. */
  Builder.prototype.or = function (text) {
    var terms = splitTop(String(text || ''));
    var parts = [];
    for (var i = 0; i < terms.length; i++) {
      var t = orTerm(this.table, terms[i]);
      if (t) parts.push(t);
    }
    if (parts.length) this.filters.push('(' + parts.join(' || ') + ')');
    return this;
  };

  Builder.prototype.order = function (col, opts) {
    var asc = !(opts && opts.ascending === false);
    this.sorts.push((asc ? '' : '-') + pbCol(this.table, col));
    return this;
  };

  Builder.prototype.limit = function (n) {
    this.perPage = Number(n) || this.perPage;
    return this;
  };

  Builder.prototype.insert = function (data) {
    this.action = 'insert';
    this.body = data;
    return this;
  };

  Builder.prototype.update = function (data) {
    this.action = 'update';
    this.body = data;
    return this;
  };

  Builder.prototype.delete = function () {
    this.action = 'delete';
    return this;
  };

  Builder.prototype.maybeSingle = function () {
    this.rowMode = 'maybe';
    return this;
  };
  Builder.prototype.single = function () {
    this.rowMode = 'one';
    return this;
  };

  Builder.prototype.filterString = function () {
    return this.filters.join(' && ');
  };

  Builder.prototype.listPath = function (extra) {
    var q = [];
    var f = this.filterString();
    if (f) q.push('filter=' + encodeURIComponent(f));
    if (this.sorts.length) q.push('sort=' + encodeURIComponent(this.sorts.join(',')));
    q.push('perPage=' + Math.max(1, Math.min(500, this.perPage)));
    if (extra && extra.expand && extra.expand.length) {
      q.push('expand=' + encodeURIComponent(extra.expand.join(',')));
    }
    if (extra && extra.fields) q.push('fields=' + encodeURIComponent(extra.fields));
    return '/api/collections/' + this.table + '/records?' + q.join('&');
  };

  function shapeOut(builder, rows) {
    var data;
    if (builder.rowMode === 'one') data = rows.length ? rows[0] : null;
    else if (builder.rowMode === 'maybe') data = rows.length ? rows[0] : null;
    else data = rows;
    return { data: data, error: null };
  }

  Builder.prototype.run = function () {
    var self = this;
    var expand = expandList(this.spec);

    if (this.action === 'select') {
      return req('GET', this.listPath({ expand: expand })).then(function (r) {
        if (r.error) return { data: null, error: r.error };
        var items = (r.data && r.data.items) || [];
        var rows = [];
        for (var i = 0; i < items.length; i++) {
          rows.push(projectRow(self.table, items[i], self.spec));
        }
        return shapeOut(self, rows);
      });
    }

    if (this.action === 'insert') {
      return req('POST', '/api/collections/' + this.table + '/records', this.body).then(
        function (r) {
          if (r.error) return { data: null, error: r.error };
          var row = projectRow(self.table, r.data, self.spec);
          if (self.rowMode) return { data: row, error: null };
          // Без .select() supabase возвращает data:null, но отдать запись
          // полезнее и ничего не ломает (приложение проверяет только error).
          return { data: self.spec ? [row] : [projectRow(self.table, r.data, null)], error: null };
        }
      );
    }

    /* UPDATE и DELETE в приложении адресованы ФИЛЬТРУ, а не одному id:
     *   .update({read_at}).eq('recipient_id', me).eq('sender_id', peer).is('read_at', null)
     * У PocketBase нет пакетной правки по фильтру, поэтому сначала находим
     * подходящие записи, затем правим/удаляем каждую. Для переписки это
     * несколько строк, а не тысячи. */
    return req('GET', this.listPath({})).then(function (r) {
      if (r.error) return { data: null, error: r.error };
      var items = (r.data && r.data.items) || [];
      if (!items.length) return { data: [], error: null };

      var path = '/api/collections/' + self.table + '/records/';
      var chain = Promise.resolve();
      var out = [];
      var firstError = null;

      for (var i = 0; i < items.length; i++) {
        (function (rec) {
          chain = chain.then(function () {
            if (firstError) return null;
            if (self.action === 'delete') {
              return req('DELETE', path + rec.id).then(function (d) {
                if (d.error) firstError = d.error;
                return null;
              });
            }
            return req('PATCH', path + rec.id, self.body).then(function (u) {
              if (u.error) {
                firstError = u.error;
                return null;
              }
              out.push(projectRow(self.table, u.data, self.spec));
              return null;
            });
          });
        })(items[i]);
      }

      return chain.then(function () {
        if (firstError) return { data: null, error: firstError };
        if (self.rowMode) return { data: out.length ? out[0] : null, error: null };
        return { data: out, error: null };
      });
    });
  };

  /* supabase-js возвращает «тогдабельный» построитель: приложение делает
   * .then(...) прямо на цепочке и ждёт { data, error }. */
  Builder.prototype.then = function (onOk, onErr) {
    return this.run().then(onOk, onErr);
  };
  Builder.prototype.catch = function (onErr) {
    return this.run().catch(onErr);
  };

  /* =====================================================================
   * Realtime: один поток SSE на всю страницу
   * ===================================================================== */
  /* Подписка нужна только на две коллекции:
   *   bus      — пинги («сходи перечитай»), сигналинг WebRTC, пульт фильма
   *   presence — кто сейчас в комнате
   * Событие приходит на всю коллекцию, а нужный канал выбирается на клиенте по
   * полю topic: у PocketBase подписка не бывает с фильтром по значению поля.
   * При 30–50 людях это несколько событий в минуту. */

  var SUBSCRIBE_TO = ['bus', 'presence'];

  var hub = {
    ctl: null,
    reading: false,
    clientId: null,
    channels: [],
    token: '',
    tries: 0,
    timer: null,
    ready: false
  };

  function hubStatus(status) {
    for (var i = 0; i < hub.channels.length; i++) fireStatus(hub.channels[i], status);
  }

  function fireStatus(ch, status) {
    ch.status = status;
    for (var i = 0; i < ch.statusCbs.length; i++) {
      try {
        ch.statusCbs[i](status);
      } catch (e) {}
    }
  }

  /* Разбор SSE: блоки разделяются пустой строкой; внутри — строки
   * `event: имя` и `data: json`. */
  function feed(chunkText) {
    var buf = chunkText;
    var i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      var block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      var ev = '';
      var data = '';
      var lines = block.split('\n');
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data = ln.slice(5).trim();
      }
      if (!ev) continue;
      if (ev === 'PB_CONNECT') {
        try {
          hub.clientId = JSON.parse(data).clientId;
        } catch (e) {
          hub.clientId = null;
        }
        sendSubscriptions();
      } else {
        dispatch(ev, data);
      }
    }
    return buf;
  }

  function sendSubscriptions() {
    if (!hub.clientId) return;
    req('POST', '/api/realtime', {
      clientId: hub.clientId,
      subscriptions: SUBSCRIBE_TO
    }).then(function () {
      hub.tries = 0;
      hub.ready = true;
      hubStatus('SUBSCRIBED');
      // Присутствие перечитываем после каждой подписки: пока связи не было,
      // кто-то мог войти или выйти.
      refreshAllPresence();
    });
  }

  /* Поток читаем обычным fetch: EventSource не умеет Authorization, а подписка
   * на защищённые коллекции без него не пройдёт (проверено на живом сервере).
   * net.js здесь не годится — у него дедлайн, а поток живёт часами. */
  function hubStart() {
    if (hub.reading) return;
    if (!BASE || !token()) return;

    hub.ctl = typeof AbortController === 'function' ? new AbortController() : null;
    hub.reading = true;

    var init = { method: 'GET', headers: { Authorization: token() } };
    if (hub.ctl) init.signal = hub.ctl.signal;

    window
      .fetch(BASE + '/api/realtime', init)
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.getReader) {
          hub.reading = false;
          hubRetry();
          return null;
        }
        var reader = res.body.getReader();
        var dec = window.TextDecoder ? new TextDecoder() : null;
        var buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return null;
            var text = dec ? dec.decode(r.value, { stream: true }) : String.fromCharCode.apply(null, r.value);
            buf = feed(buf + text);
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        return null;
      })
      .then(function () {
        hub.reading = false;
        hub.clientId = null;
        hub.ready = false;
        hubStatus('CLOSED');
        hubRetry();
      });
  }

  /* Переподключение с нарастающей паузой. PocketBase сам закрывает поток
   * (по умолчанию около 30 минут), так что это штатный путь, а не аварийный. */
  function hubRetry() {
    if (!hub.channels.length || !token()) return;
    hub.tries++;
    var wait = Math.min(15000, 800 * Math.pow(1.6, Math.min(hub.tries, 8)));
    if (hub.timer) clearTimeout(hub.timer);
    hub.timer = setTimeout(function () {
      hub.timer = null;
      hubStart();
    }, wait);
  }

  function hubStop() {
    if (hub.timer) {
      clearTimeout(hub.timer);
      hub.timer = null;
    }
    if (hub.ctl) {
      try {
        hub.ctl.abort();
      } catch (e) {}
    }
    hub.ctl = null;
    hub.reading = false;
    hub.clientId = null;
    hub.ready = false;
    hub.tries = 0;
  }

  function dispatch(evName, data) {
    var rec = null;
    var action = 'create';
    try {
      var parsed = JSON.parse(data);
      rec = parsed.record || parsed;
      action = parsed.action || 'create';
    } catch (e) {
      return;
    }
    if (!rec) return;

    if (evName === 'bus') {
      for (var i = 0; i < hub.channels.length; i++) {
        var ch = hub.channels[i];
        if (ch.name !== rec.topic) continue;
        for (var h = 0; h < ch.handlers.length; h++) {
          var hd = ch.handlers[h];
          if (hd.type !== 'broadcast') continue;
          if (hd.event && hd.event !== rec.ev) continue;
          try {
            hd.cb({ type: 'broadcast', event: rec.ev, payload: rec.payload || {} });
          } catch (e) {}
        }
      }
      return;
    }

    if (evName === 'presence') {
      for (var p = 0; p < hub.channels.length; p++) {
        var pc = hub.channels[p];
        if (pc.name !== rec.topic) continue;
        applyPresenceRecord(pc, action, rec);
      }
    }
  }

  /* =====================================================================
   * Присутствие
   * ===================================================================== */

  function applyPresenceRecord(ch, action, rec) {
    if (action === 'delete') {
      delete ch.presence[rec.pkey];
    } else {
      ch.presence[rec.pkey] = [rec.state || {}];
    }
    firePresence(ch, action === 'delete' ? 'leave' : action === 'create' ? 'join' : 'sync');
  }

  function firePresence(ch, kind) {
    for (var i = 0; i < ch.handlers.length; i++) {
      var h = ch.handlers[i];
      if (h.type !== 'presence') continue;
      try {
        h.cb({ event: kind });
      } catch (e) {}
    }
  }

  function refreshAllPresence() {
    for (var i = 0; i < hub.channels.length; i++) loadPresence(hub.channels[i]);
  }

  function loadPresence(ch) {
    req(
      'GET',
      '/api/collections/presence/records?perPage=200&filter=' +
        encodeURIComponent('topic = "' + escQ(ch.name) + '"')
    ).then(function (r) {
      if (r.error || !r.data) return;
      var map = {};
      var items = r.data.items || [];
      for (var i = 0; i < items.length; i++) {
        map[items[i].pkey] = [items[i].state || {}];
      }
      ch.presence = map;
      firePresence(ch, 'sync');
    });
  }

  function presencePath(topic, pkey) {
    return (
      '/api/collections/presence/records?perPage=1&filter=' +
      encodeURIComponent('topic = "' + escQ(topic) + '" && pkey = "' + escQ(pkey) + '"')
    );
  }

  function upsertPresence(ch, state, done) {
    var body = {
      topic: ch.name,
      pkey: ch.presenceKey,
      state: state,
      seen_at: new Date().toISOString()
    };
    if (ch.presenceId) {
      req('PATCH', '/api/collections/presence/records/' + ch.presenceId, body).then(
        function (r) {
          if (done) done(r);
        }
      );
      return;
    }
    req('GET', presencePath(ch.name, ch.presenceKey)).then(function (r) {
      var found = r.data && r.data.items && r.data.items[0];
      if (found) {
        ch.presenceId = found.id;
        req('PATCH', '/api/collections/presence/records/' + found.id, body).then(function (x) {
          if (done) done(x);
        });
      } else {
        req('POST', '/api/collections/presence/records', body).then(function (x) {
          if (x.data && x.data.id) ch.presenceId = x.data.id;
          if (done) done(x);
        });
      }
    });
  }

  /* =====================================================================
   * Канал
   * ===================================================================== */

  function Channel(name, opts) {
    this.name = name;
    this.handlers = [];
    this.statusCbs = [];
    this.status = 'CLOSED';
    this.presence = {};
    this.presenceId = null;
    this.tracking = null;
    this.heartbeat = null;
    var key = null;
    try {
      key = opts && opts.config && opts.config.presence && opts.config.presence.key;
    } catch (e) {}
    // Ключ присутствия приложение задаёт само ('A:<uid>'), чтобы хост и гость
    // не затирали друг друга. Если не задан — ключ по своему id.
    this.presenceKey = key || 'u:' + (myId() || 'anon');
  }

  Channel.prototype.on = function (type, filter, cb) {
    var event = null;
    if (filter && filter.event) event = filter.event;
    this.handlers.push({ type: type, event: event, cb: cb });
    return this;
  };

  Channel.prototype.subscribe = function (cb) {
    var self = this;
    if (typeof cb === 'function') {
      this.statusCbs.push(cb);
      if (this.status === 'SUBSCRIBED') {
        try {
          cb('SUBSCRIBED');
        } catch (e) {}
      }
    }
    if (hub.channels.indexOf(this) < 0) hub.channels.push(this);

    if (!BASE || !token()) {
      fireStatus(this, 'CHANNEL_ERROR');
      return this;
    }

    loadPresence(this);
    hubStart();

    // Статус прилетит из sendSubscriptions() → hubStatus('SUBSCRIBED').
    // Но если поток уже поднят, скажем сразу: приложение ждёт сигнала, чтобы
    // снять подпись присутствия и разослать отложенные пинги.
    if (hub.ready) fireStatus(this, 'SUBSCRIBED');

    if (this.tracking) startHeartbeat(this);
    return this;
  };

  /* Отправить по каналу = записать в `bus`. Другого транспорта у PocketBase
   * нет, и этого достаточно: получатель увидит запись через SSE. */
  Channel.prototype.send = function (msg) {
    if (!msg || msg.type !== 'broadcast') return Promise.resolve({ error: null });
    var payload = msg.payload === undefined ? {} : msg.payload;
    return req('POST', '/api/collections/bus/records', {
      topic: this.name,
      ev: msg.event || '',
      payload: payload,
      sender_id: myId() || null
    });
  };

  Channel.prototype.track = function (state) {
    this.tracking = state || {};
    var self = this;
    upsertPresence(this, this.tracking, function () {
      startHeartbeat(self);
    });
    return Promise.resolve({ error: null });
  };

  Channel.prototype.untrack = function () {
    stopHeartbeat(this);
    this.tracking = null;
    var self = this;
    var id = this.presenceId;
    this.presenceId = null;
    this.presence = {};
    if (!id) return Promise.resolve({ error: null });
    return req('DELETE', '/api/collections/presence/records/' + id).then(function (r) {
      return r;
    });
  };

  Channel.prototype.presenceState = function () {
    // Копия, чтобы вызывающий не подменил наши данные.
    var out = {};
    for (var k in this.presence) {
      if (Object.prototype.hasOwnProperty.call(this.presence, k)) out[k] = this.presence[k];
    }
    return out;
  };

  function startHeartbeat(ch) {
    stopHeartbeat(ch);
    // 10 с при пороге уборки 45 с: три пропущенных удара до того, как человека
    // посчитают ушедшим. Так моргнувшая сеть не выбрасывает из комнаты.
    ch.heartbeat = setInterval(function () {
      if (!ch.tracking) return;
      upsertPresence(ch, ch.tracking, null);
    }, 10000);
  }

  function stopHeartbeat(ch) {
    if (ch.heartbeat) {
      clearInterval(ch.heartbeat);
      ch.heartbeat = null;
    }
  }

  /* =====================================================================
   * Хранилище: фильм как части в коллекции films
   * ===================================================================== */

  function parseFilmPath(path) {
    // Приложение складывает путь как `<код комнаты>/<id фильма>/<номер части>`.
    var parts = String(path || '').split('/');
    if (parts.length < 3) return null;
    var idx = Number(parts[2]);
    if (!isFinite(idx)) return null;
    return { room: parts[0], movie: parts[1], idx: idx };
  }

  function findFilm(p) {
    var filter =
      'room = "' + escQ(p.room) + '" && movie = "' + escQ(p.movie) + '" && idx = ' + p.idx;
    return req(
      'GET',
      '/api/collections/films/records?perPage=1&filter=' + encodeURIComponent(filter)
    ).then(function (r) {
      if (r.error) return { error: r.error };
      var it = r.data && r.data.items && r.data.items[0];
      return { record: it || null, error: null };
    });
  }

  var storage = {
    from: function () {
      return {
        upload: function (path, blob, opts) {
          var p = parseFilmPath(path);
          if (!p) return Promise.resolve({ data: null, error: new Error('bad path: ' + path) });
          var form = new FormData();
          // Имя файла нужно: PocketBase сохраняет его в поле и возвращает в
          // ссылке на скачивание. Оно же потом используется в download().
          form.append('blob', blob, 'part');
          form.append('room', p.room);
          form.append('movie', p.movie);
          form.append('idx', String(p.idx));

          return findFilm(p).then(function (f) {
            if (f.error) return { data: null, error: f.error };
            var upsert = !(opts && opts.upsert === false);
            if (f.record && upsert) {
              return req(
                'PATCH',
                '/api/collections/films/records/' + f.record.id,
                form,
                { timeout: FILE_TIMEOUT }
              ).then(function (r) {
                return r.error ? { data: null, error: r.error } : { data: { path: path }, error: null };
              });
            }
            return req('POST', '/api/collections/films/records', form, {
              timeout: FILE_TIMEOUT
            }).then(function (r) {
              return r.error ? { data: null, error: r.error } : { data: { path: path }, error: null };
            });
          });
        },

        download: function (path) {
          var p = parseFilmPath(path);
          if (!p) return Promise.resolve({ data: null, error: new Error('bad path: ' + path) });
          return findFilm(p).then(function (f) {
            if (f.error) return { data: null, error: f.error };
            if (!f.record || !f.record.blob) {
              return { data: null, error: new Error('нет такой части фильма: ' + path) };
            }
            var url =
              BASE +
              '/api/files/films/' +
              encodeURIComponent(f.record.id) +
              '/' +
              encodeURIComponent(f.record.blob);
            var f0 = (window.KSU_NET && window.KSU_NET.fetch) || window.fetch;
            return f0(url, {
              method: 'GET',
              headers: { Authorization: token() },
              ksuTimeout: FILE_TIMEOUT,
              ksuTries: 3,
              cache: 'no-store'
            }).then(function (res) {
              if (!res.ok) return { data: null, error: new Error('HTTP ' + res.status) };
              return res.blob().then(function (b) {
                return { data: b, error: null };
              });
            });
          });
        },

        remove: function (path) {
          var p = parseFilmPath(path);
          if (!p) return Promise.resolve({ data: null, error: new Error('bad path: ' + path) });
          return findFilm(p).then(function (f) {
            if (!f.record) return { data: null, error: null };
            return req('DELETE', '/api/collections/films/records/' + f.record.id);
          });
        }
      };
    }
  };

  /* =====================================================================
   * Авторизация
   * ===================================================================== */
  /* Приложение по-прежнему передаёт «email», синтезированный из имени
   * (name@ksunimeet.example.com) — менять его не хочется, это отлаженный код.
   * Здесь адрес не нужен вовсе: вход по имени, и имя берётся из адреса до @. */

  function usernameFromIdentity(v) {
    var s = String(v || '').trim().toLowerCase();
    var at = s.indexOf('@');
    return at > 0 ? s.slice(0, at) : s;
  }

  var authListeners = [];

  function fireAuth(evt, s) {
    for (var i = 0; i < authListeners.length; i++) {
      try {
        authListeners[i](evt, s);
      } catch (e) {}
    }
  }

  /* Сообщения об ошибках переводим в те, которые приложение уже узнаёт и
   * показывает по-русски. PocketBase говорит «Failed to authenticate», и без
   * этого человек увидел бы английскую строку вместо «Неверное имя или пароль». */
  function authErrorFrom(r, kind) {
    var msg = (r.error && r.error.message) || '';
    if (kind === 'signin') {
      var e1 = new Error('Invalid login credentials');
      e1.status = r.status;
      return e1;
    }
    if (/unique|already/i.test(msg)) {
      return new Error('A user with this username already exists');
    }
    if (/password/i.test(msg) && /less|short|length/i.test(msg)) {
      return new Error('Password should be at least 6 characters');
    }
    var e2 = new Error(msg || 'signup failed');
    e2.status = r.status;
    return e2;
  }

  function afterSignIn(tokenValue, record, evt) {
    var s = toSession(tokenValue, record);
    saveSession(s);
    hub.token = tokenValue;
    if (evt) fireAuth(evt, s);
    return s;
  }

  var auth = {
    signUp: function (args) {
      var name = usernameFromIdentity(args && (args.email || (args.options && args.options.data && args.options.data.username)));
      var pass = (args && args.password) || '';
      return req('POST', '/api/collections/profiles/records', {
        username: name,
        password: pass,
        passwordConfirm: pass
      }).then(function (r) {
        if (r.error) return { data: null, error: authErrorFrom(r, 'signup') };
        // Подтверждения почты нет, поэтому сессии ждать не от кого: сразу
        // входим тем же паролем, чтобы приложение получило токен.
        return req('POST', '/api/collections/profiles/auth-with-password', {
          identity: name,
          password: pass
        }).then(function (a) {
          if (a.error) return { data: null, error: authErrorFrom(a, 'signin') };
          var s = afterSignIn(a.data.token, a.data.record, 'SIGNED_IN');
          return { data: { session: s, user: s.user }, error: null };
        });
      });
    },

    signInWithPassword: function (args) {
      var name = usernameFromIdentity(args && args.email);
      var pass = (args && args.password) || '';
      return req('POST', '/api/collections/profiles/auth-with-password', {
        identity: name,
        password: pass
      }).then(function (r) {
        if (r.error) return { data: null, error: authErrorFrom(r, 'signin') };
        var s = afterSignIn(r.data.token, r.data.record, 'SIGNED_IN');
        return { data: { session: s, user: s.user }, error: null };
      });
    },

    signOut: function () {
      try {
        for (var i = 0; i < hub.channels.length; i++) {
          var ch = hub.channels[i];
          stopHeartbeat(ch);
          ch.presenceId = null;
          ch.status = 'CLOSED';
        }
      } catch (e) {}
      hubStop();
      saveSession(null);
      hub.token = '';
      fireAuth('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },

    getSession: function () {
      if (!session || !session.access_token) return Promise.resolve({ data: { session: null } });
      // Токен на исходе — продлеваем заранее, иначе вход «сам перестанет
      // работать» посреди дня.
      var exp = tokenExpiresAt(session.access_token);
      if (exp && exp - Date.now() < 24 * 3600 * 1000) {
        return req('POST', '/api/collections/profiles/auth-refresh').then(
          function (r) {
            if (r.error || !r.data) return { data: { session: session } };
            var s = afterSignIn(r.data.token, r.data.record, 'TOKEN_REFRESHED');
            return { data: { session: s } };
          },
          function () {
            return { data: { session: session } };
          }
        );
      }
      return Promise.resolve({ data: { session: session } });
    },

    setSession: function (s) {
      saveSession(s);
      return Promise.resolve({ data: { session: s }, error: null });
    },

    onAuthStateChange: function (cb) {
      authListeners.push(cb);
      return {
        data: {
          subscription: {
            unsubscribe: function () {
              for (var i = 0; i < authListeners.length; i++) {
                if (authListeners[i] === cb) authListeners.splice(i, 1);
              }
            }
          }
        }
      };
    }
  };

  var realtime = {
    setAuth: function (tok) {
      // Токен подписки: поток SSE открывается заново, потому что у уже
      // открытого соединения заголовки не поменять.
      if (tok && tok !== hub.token) {
        hub.token = tok;
        if (hub.channels.length) {
          hubStop();
          hubStart();
        }
      }
    },
    getChannels: function () {
      return hub.channels.slice();
    }
  };

  /* =====================================================================
   * Публичный интерфейс — ровно тот же, что у supabase-js
   * ===================================================================== */

  function createClient() {
    var sb = {
      from: function (table) {
        return new Builder(table);
      },
      rpc: function () {
        // Ни одного вызова rpc в приложении нет; пусть падает громко, если
        // однажды появится, а не молча отдаёт пустоту.
        return Promise.reject(new Error('pb.js: rpc() не реализован (и не использовался)'));
      },
      channel: function (name, opts) {
        return new Channel(name, opts);
      },
      removeChannel: function (ch) {
        if (!ch) return Promise.resolve();
        var p = Promise.resolve();
        try {
          p = ch.untrack() || p;
        } catch (e) {}
        var i = hub.channels.indexOf(ch);
        if (i >= 0) hub.channels.splice(i, 1);
        fireStatus(ch, 'CLOSED');
        if (!hub.channels.length) hubStop();
        return p;
      },
      auth: auth,
      storage: storage,
      realtime: realtime
    };
    return sb;
  }

  /* Приложение само поднимает поток только при входе, но если поток нужен, а
   * его нет — подстрахуемся на возврат вкладки: пока телефон спал, соединение
   * почти наверняка развалилось. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && hub.channels.length && !hub.reading) {
      hubStart();
    }
  });

  window.KSU_PB = {
    create: createClient,
    base: BASE,
    // Текущий токен наружу: им пользуются пробы net.js (?diag), чтобы проверить
    // поток под теми же правами, что и приложение. Дублировать ключ хранилища
    // в net.js было бы связью через невидимую нитку.
    token: token,
    timeout: function () { return { timedOut: true }; }
  };
  // ПРИЛОЖЕНИЕ НЕ МЕНЯЕТСЯ: app.js/watch.js/call.js берут window.supabase.
  // Этот файл подставляется вместо vendor/supabase.js (см. backend.js).
  window.supabase = { createClient: createClient, __pb: true };
})();
