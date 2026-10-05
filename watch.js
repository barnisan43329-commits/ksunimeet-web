/* KsuNiMeet — «Смотрим вместе» на Supabase.
 *
 * ГЛАВНАЯ ИДЕЯ (как в прежней версии, только чище):
 *   фильм НЕ идёт потоком по сети. Хост один раз заливает файл, гость один раз
 *   скачивает — дальше каждый смотрит СВОЙ локальный файл. По сети летят
 *   только команды пульта: несколько десятков байт. Отсюда ни буферизации,
 *   ни «крутится колёсико» — картинка не зависит от интернета вообще.
 *
 * СИНХРОНИЗАЦИЯ — СКОРОСТЬЮ, А НЕ ПРЫЖКАМИ. Это здесь самое важное.
 *   Позиция у обоих одна и та же по построению (файл один), расходятся только
 *   сами часы воспроизведения — на доли секунды. Прежняя версия периодически
 *   ПИСАЛА currentTime, а запись в currentTime — это пере-поиск и повторное
 *   наполнение буфера, то есть рывок. Здесь позиция не переписывается:
 *   расхождение выбирается скоростью (playbackRate 0.94…1.06). Декодер при
 *   смене скорости на 2–3% ничего не замечает, буфер не перестраивается, а
 *   разница в 0.4 с уходит за пару секунд, и ухо/глаз её не ловят.
 *   Прыжок по currentTime остаётся только на аварии (>2 с) и на входе в фильм.
 *
 * КАНАЛ УПРАВЛЕНИЯ: сначала data channel WebRTC (единицы миллисекунд,
 *   напрямую браузер↔браузер), и только если он ещё не поднялся — Broadcast
 *   в том же Realtime-канале комнаты. Обе дороги несут ОДНУ шкалу времени
 *   (часы хоста), поэтому устаревший пакет никогда не откатит картинку назад.
 *
 * ПОЧЕМУ PRESENCE И BROADCAST, А НЕ ТАБЛИЦЫ + postgres_changes:
 *   На этом проекте подписка postgres_changes не доставляет НИЧЕГО для таблиц
 *   с включённым RLS (проверено и для service_role, и с политикой using(true):
 *   при RLS off события идут, при RLS on — нет). Presence и broadcast той же
 *   Realtime-службы работают исправно и не проходят через проверку строк по
 *   RLS. Поэтому «кто здесь» держит Presence, а пульт — broadcast, и ничего
 *   не зависит от доставки строк из БД.
 *
 *   Единственное, что по-прежнему ходит через REST, — что именно за фильм
 *   лежит в комнате (rooms.movie): это данные, а не события, и у гостя есть
 *   дешёвый опрос-подстраховка на случай, если broadcast он проспал.
 */
(function () {
  'use strict';

  var CFG = window.KSU_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var LANG_KEY = 'ksu_lang';

  var lang = (function () {
    try { var s = localStorage.getItem(LANG_KEY); if (s === 'ru' || s === 'en') return s; } catch (e) {}
    return /^(ru|be|uk|kk)/.test((navigator.language || '').toLowerCase()) ? 'ru' : 'en';
  })();

  /* ВСЕ надписи на экране — здесь. Русский и английский рядом, поэтому
   * «забыл перевести» ловится глазом: ключ без пары виден сразу. */
  var L = {
    ru: {
      title: 'Смотрим вместе',
      sub: 'Фильм у каждого свой локально · управление одно на двоих',
      back: 'В приложение',
      lobby_micro: 'Комната для двоих',
      lobby_text: 'Хост выбирает фильм — он заливается в комнату по частям. Второй подключается, скачивает тот же файл и смотрит его <strong>локально</strong>: ни буферизации, ни «крутится колёсико». Пауза, перемотка и громкость — общие, а расхождение подбирается скоростью воспроизведения, а не прыжками по фильму.',
      im_host: 'Я хост', create: 'Создать комнату',
      im_guest: 'Я гость', join: 'Подключиться', code_ph: 'КОД',
      code_micro: 'Код комнаты', copy: 'Скопировать', leave: 'Выйти',
      film_micro: 'Фильм', film: 'Фильм',
      pick_text: 'Лучше всего играет <strong>MP4 (H.264)</strong> или <strong>WebM</strong> — их понимает любой браузер. Файл уходит частями по 45 МБ: переживает обрыв и медленный канал.',
      pick_btn: 'Выбрать файл', dl_btn: 'Скачать фильм', plock: 'Управляет хост',
      play_pause: 'Плей / пауза', seek_label: 'Перемотка', volume: 'Громкость',
      fullscreen: 'Полный экран',
      wait_host: 'Ждём хоста…', wait_guest: 'Ждём гостя…',
      host_here: 'Хост в комнате', guest_here: 'Гость в комнате',
      uploading: 'Заливаю фильм в комнату', ready: 'Фильм готов — гость может скачать',
      downloading: 'Скачиваю фильм', downloaded: 'Фильм скачан — можно смотреть',
      no_file: 'Хост ещё не выбрал фильм.', pick_first: 'Выберите фильм.',
      guest_ctrl: 'Гость управляет', host_ctrl: 'Гость не управляет',
      mic_on: 'Микрофон вкл', mic_off: 'Микрофон выкл',
      synced: 'синхронно', away: 'расхождение', left: 'Собеседник вышел',
      copied: 'Код скопирован', voice: 'Голос',
      not_supported: 'Этот файл браузер проиграть не сможет. Нужен MP4 (H.264) или WebM.',
      lobby_err: 'Код комнаты — 5 символов: буквы и цифры.',
      no_room: 'Комната не найдена.', own_room: 'Это ваша комната — вы хост.',
      upload_failed: 'Не удалось залить фильм.', reupload: 'Хост заливает заново…',
      no_mic: 'Нет доступа к микрофону',
      of: 'из', parts: 'частей',
      gb: 'ГБ', mb: 'МБ', kb: 'КБ', by: 'Б'
    },
    en: {
      title: 'Watch together',
      sub: 'Each of you plays a local copy · one remote for both',
      back: 'Back to app',
      lobby_micro: 'A room for two',
      lobby_text: 'The host picks a film — it is uploaded to the room in parts. The other one joins, downloads the very same file and plays it <strong>locally</strong>: no buffering, no spinning wheel. Pause, seeking and volume are shared, and drift is corrected with the playback rate rather than by jumping around the film.',
      im_host: "I'm the host", create: 'Create a room',
      im_guest: "I'm the guest", join: 'Join', code_ph: 'CODE',
      code_micro: 'Room code', copy: 'Copy', leave: 'Leave',
      film_micro: 'Film', film: 'Film',
      pick_text: 'The safest bet is <strong>MP4 (H.264)</strong> or <strong>WebM</strong> — every browser understands them. The file travels in 45 MB parts, so a dropped connection or a slow link will not kill it.',
      pick_btn: 'Choose a file', dl_btn: 'Download film', plock: 'Host controls',
      play_pause: 'Play / pause', seek_label: 'Seek', volume: 'Volume',
      fullscreen: 'Fullscreen',
      wait_host: 'Waiting for the host…', wait_guest: 'Waiting for the guest…',
      host_here: 'Host is in the room', guest_here: 'Guest is in the room',
      uploading: 'Uploading the film', ready: 'Film is ready — the guest can download',
      downloading: 'Downloading the film', downloaded: 'Film downloaded — ready to watch',
      no_file: 'The host has not picked a film yet.', pick_first: 'Pick a film.',
      guest_ctrl: 'Guest controls', host_ctrl: 'Host controls',
      mic_on: 'Mic on', mic_off: 'Mic off',
      synced: 'in sync', away: 'drift', left: 'Peer left',
      copied: 'Code copied', voice: 'Voice',
      not_supported: 'The browser cannot play this file. Use MP4 (H.264) or WebM.',
      lobby_err: 'A room code is 5 characters: letters and digits.',
      no_room: 'Room not found.', own_room: 'That is your own room.',
      upload_failed: 'Upload failed.', reupload: 'Host is re-uploading…',
      no_mic: 'No microphone access',
      of: 'of', parts: 'parts',
      gb: 'GB', mb: 'MB', kb: 'KB', by: 'B'
    }
  };
  function T(k) { return (L[lang] && L[lang][k]) || L.ru[k] || k; }

  /* Надписи, которые живут прямо в разметке: data-i18n / data-i18n-ph /
   * data-i18n-aria. Так html не приходится держать перевод у себя. */
  function applyLang() {
    var i, els;
    els = document.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-i18n');
      if (/text$/.test(k)) els[i].innerHTML = T(k);
      else els[i].textContent = T(k);
    }
    els = document.querySelectorAll('[data-i18n-ph]');
    for (i = 0; i < els.length; i++) els[i].placeholder = T(els[i].getAttribute('data-i18n-ph'));
    els = document.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < els.length; i++) {
      var ak = els[i].getAttribute('data-i18n-aria');
      els[i].setAttribute('aria-label', T(ak));
      if (els[i].hasAttribute('title')) els[i].setAttribute('title', T(ak));
    }
    try { document.documentElement.lang = lang; } catch (e) {}
    document.title = T('title') + ' · KsuNiMeet';
    $('lang').textContent = lang === 'ru' ? 'EN' : 'RU';
  }

  if (!CFG.supabaseUrl || !window.supabase) return;
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ksu-auth' },
    realtime: { params: { eventsPerSecond: 20 } }
  });

  var STUN = [{ urls: [
    'stun:stun.cloudflare.com:3478',
    'stun:stun.nextcloud.com:443',
    'stun:stun.syncthing.net:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
  ] }];

  /* TURN приезжает из turn.js асинхронно (свежие креды), поэтому соединение
   * строится после turnReady. Пустой бюджет — ожидания нет. */
  var TURN = [];
  var turnReady = (window.KSU_TURN_READY || Promise.resolve(window.KSU_TURN_SERVERS || []))
    .then(function (l) { TURN = l || []; }, function () { TURN = []; });

  var CHUNK = 45 * 1024 * 1024;   // предел бесплатного Supabase — 50 МБ на объект
  var BUCKET = 'ksu-films';

  var me = null;
  var code = (q.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var role = q.get('role') === 'B' ? 'B' : (q.get('role') === 'A' ? 'A' : null);

  var movie = null;            // rooms.movie
  var localUrl = null;
  var downloadedFor = null;    // id фильма, который уже лежит локально
  var playerReady = false, playerBound = false;
  var uploading = false, downloading = false;
  var grantOn = false;
  var peerHere = false, peerName = '';
  var pc = null, pcBuilding = false, dc = null, dcon = false, connected = false;
  var audioSender = null, silentTrack = null, micTrack = null, silentCtx = null;
  var micOn = false;
  var hostState = null, lastSyncAt = 0;
  var justJoinedAt = 0;
  var roomCh = null;
  var voiceTimers = null, anchorInt = null, rateInt = null, movieInt = null;
  var lastHttpSync = 0;
  var lastCtrlN = 0;

  function nowMs() { return window.performance ? performance.now() : Date.now(); }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var m = Math.floor(s / 60), ss = s % 60, h = Math.floor(m / 60);
    m = m % 60;
    return (h > 0 ? h + ':' + ('0' + m).slice(-2) : ('0' + m).slice(-2)) + ':' + ('0' + ss).slice(-2);
  }
  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' ' + T('gb');
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' ' + T('mb');
    if (b > 1024) return (b / 1024).toFixed(0) + ' ' + T('kb');
    return b + ' ' + T('by');
  }
  var toastTimer = null;
  function toast(m) {
    var el = $('toast');
    el.textContent = m;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 2200);
  }
  function show(id, on) { var e = $(id); if (e) e.classList.toggle('hidden', !on); }
  function err(m) { $('lobby-err').textContent = m || ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= лобби ================= */

  function randomCode() {
    var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  function createRoom() {
    if (!me) return;
    var c = randomCode();
    sb.from('rooms').insert({ code: c, host_id: me.id }).then(function (r) {
      if (r.error) { err(r.error.message); return; }
      code = c; role = 'A';
      try { history.replaceState({}, '', '?code=' + c + '&role=A'); } catch (e) {}
      enterRoom();
    });
  }

  function joinRoom() {
    var c = ($('joincode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 5) { err(T('lobby_err')); return; }
    sb.from('rooms').select('code,host_id').eq('code', c).maybeSingle().then(function (r) {
      if (r.error || !r.data) { err(T('no_room')); return; }
      if (r.data.host_id === me.id) { err(T('own_room')); return; }
      code = c; role = 'B';
      try { history.replaceState({}, '', '?code=' + c + '&role=B'); } catch (e) {}
      enterRoom();
    });
  }

  function enterRoom() {
    show('lobby', false);
    show('room', true);
    $('rcode').textContent = code;
    show('pick', role === 'A');
    show('status', true);
    $('dl').textContent = T('dl_btn');

    startRoom();     // presence + broadcast + REST-подстраховка
    startVoice();
    startAnchor();
    startRateLoop();
    loadMovie();     // фильм мог быть выбран ДО нашего входа

    justJoinedAt = nowMs();
    syncControls();
    renderPeople();
    renderStatus();
  }

  /* ================= транспорт комнаты =================
   * Один канал на всё: presence («кто здесь»), сигналинг WebRTC, пульт и
   * сообщение о том, какой фильм лежит в комнате. Ключ presence — роль+uid,
   * поэтому хост и гость не затирают друг друга, даже если это один аккаунт
   * в двух вкладках. */

  function startRoom() {
    if (roomCh) { try { sb.removeChannel(roomCh); } catch (e) {} roomCh = null; }
    roomCh = sb.channel('ksu-room-' + code, {
      config: { presence: { key: role + ':' + me.id } }
    });

    roomCh
      .on('presence', { event: 'sync' }, readPresence)
      .on('presence', { event: 'join' }, readPresence)
      .on('presence', { event: 'leave' }, readPresence)
      .on('broadcast', { event: 'movie' }, function (p) {
        if (role !== 'B' || !p) return;
        setMovie(p.payload);
      })
      .on('broadcast', { event: 'sync' }, function (p) {
        if (role !== 'B' || !p) return;
        applySync(p.payload);
      })
      .on('broadcast', { event: 'ctrl' }, function (p) {
        if (role !== 'A' || !p || !p.payload) return;
        if (p.payload.from !== 'B') return;
        runCtrl(p.payload);
      })
      .on('broadcast', { event: 'grant' }, function (p) {
        if (role !== 'B' || !p || !p.payload) return;
        setGrant(!!p.payload.on, true);
      })
      .on('broadcast', { event: 'sig' }, function (p) {
        if (!p || !p.payload) return;
        onSignal(p.payload);
      })
      .on('broadcast', { event: 'need' }, function () {
        if (role !== 'A') return;
        pushMovie();
        if (playerReady) { lastHttpSync = 0; pushState(); }
        maybeOffer();
      })
      .on('broadcast', { event: 'bye' }, function () {
        toast(T('left'));
        peerGone();
      })
      .subscribe(function (status) {
        if (status !== 'SUBSCRIBED') return;
        roomCh.track({ role: role, name: (me && me.username) || '' });
        readPresence();
        if (role === 'A') pushMovie();
      });
  }

  function send(ev, payload) {
    if (!roomCh) return;
    try { roomCh.send({ type: 'broadcast', event: ev, payload: payload || {} }); } catch (e) {}
  }

  /* «Кто здесь» — по presence-состоянию канала, а не по таблице. Мгновенно,
   * без опроса, без часов: выход виден сразу, потому что подпись снимается
   * самим сокетом. */
  var hadPeer = false, peerGoneTimer = null;

  function readPresence() {
    var st = (roomCh && roomCh.presenceState && roomCh.presenceState()) || {};
    var want = role === 'A' ? 'B' : 'A';
    var found = null;
    Object.keys(st).forEach(function (k) {
      (st[k] || []).forEach(function (m) {
        if (m && m.role === want) found = m;
      });
    });
    peerHere = !!found;
    peerName = found ? (found.name || '') : '';
    renderPeople();

    if (peerHere) {
      if (peerGoneTimer) { clearTimeout(peerGoneTimer); peerGoneTimer = null; }
      if (role === 'A') {
        pushMovie();
        if (playerReady) { lastHttpSync = 0; pushState(); }
        maybeOffer();
      } else {
        send('need', {});
      }
      hadPeer = true;
      return;
    }

    // Пропажа может быть секундной (сокет переподключается) — не паникуем.
    if (hadPeer && !peerGoneTimer) {
      peerGoneTimer = setTimeout(function () {
        peerGoneTimer = null;
        if (peerHere) return;
        hadPeer = false;
        toast(T('left'));
        peerGone();
      }, 2000);
    }
  }

  function peerGone() {
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    pc = null; dc = null; dcon = false; connected = false;
    renderPeople();
    if (role === 'A') setTimeout(function () { if (!pc) maybeOffer(); }, 800);
  }

  function renderPeople() {
    var out = [];
    if (peerHere) {
      out.push('<span class="person on"><span class="dot"></span>' +
        (role === 'A' ? T('guest_here') : T('host_here')) +
        (peerName ? ' · ' + esc(peerName) : '') + '</span>');
    } else {
      out.push('<span class="person"><span class="dot"></span>' +
        (role === 'A' ? T('wait_guest') : T('wait_host')) + '</span>');
    }
    if (connected) out.push('<span class="person on"><span class="dot"></span>' + T('voice') + '</span>');
    $('people').innerHTML = out.join('');
  }

  /* ================= фильм в комнате ================= */

  /* Хост: залить состояние фильма в комнату и сразу сказать об этом гостю. */
  function pushMovie() {
    if (role !== 'A' || !movie) return;
    send('movie', movie);
  }

  function setMovie(m) {
    if (!m) return;
    movie = m;
    renderStatus();
    if (movie.status === 'ready') stopMoviePoll();
  }

  function loadMovie() {
    sb.from('rooms').select('movie').eq('code', code).maybeSingle().then(function (r) {
      if (r.error || !r.data) return;
      var row = r.data;
      if (row.movie) setMovie(row.movie);
      else renderStatus();
    });
  }

  /* Подстраховка гостя: если broadcast проспали (или хост залил фильм до
   * нашего входа), состояние всё равно подтянется из комнаты. Опрос дешёвый
   * — одна маленькая строка — и прекращается, как только фильм готов. */
  function startMoviePoll() {
    if (movieInt) clearInterval(movieInt);
    movieInt = setInterval(function () {
      if (role !== 'B') return;
      if (movie && movie.status === 'ready') { stopMoviePoll(); return; }
      loadMovie();
    }, 3000);
  }
  function stopMoviePoll() {
    if (movieInt) { clearInterval(movieInt); movieInt = null; }
  }

  /* ================= заливка фильма (хост) ================= */

  function pickFile(file) {
    if (!file) return;
    $('pickname').textContent = file.name + ' · ' + fmtBytes(file.size);
    var id = 'm' + Date.now().toString(36);
    var chunks = Math.max(1, Math.ceil(file.size / CHUNK));
    var m = { id: id, name: file.name, size: file.size, mime: file.type || 'video/mp4',
              chunks: chunks, status: 'uploading', received: 0 };

    // Свой файл доступен сразу — хост может смотреть, пока идёт заливка.
    localUrl = URL.createObjectURL(file);
    downloadedFor = id;
    bindPlayer();

    movie = m;
    sb.from('rooms').update({ movie: m }).eq('code', code).then(function () {}, function () {});
    pushMovie();
    renderStatus();

    uploading = true;
    var sent = 0;
    var chain = Promise.resolve();
    for (var i = 0; i < chunks; i++) {
      (function (idx) {
        chain = chain.then(function () {
          var blob = file.slice(idx * CHUNK, Math.min(file.size, (idx + 1) * CHUNK));
          var path = code + '/' + id + '/' + idx;
          return sb.storage.from(BUCKET).upload(path, blob, {
            upsert: true, contentType: 'application/octet-stream', cacheControl: '3600'
          }).then(function (r) {
            if (r.error) throw r.error;
            sent++;
            m.received = Math.min(file.size, sent * CHUNK);
            renderStatus();
            pushMovie();   // гость видит прогресс, а не «замерло»
          });
        });
      })(i);
    }
    chain.then(function () {
      m.status = 'ready';
      m.received = file.size;
      uploading = false;
      movie = m;
      sb.from('rooms').update({ movie: m }).eq('code', code).then(function () {}, function () {});
      pushMovie();
      renderStatus();
      toast(T('ready'));
    }).catch(function (e) {
      uploading = false;
      m.status = 'error';
      movie = m;
      pushMovie();
      renderStatus();
      toast((e && e.message) || T('upload_failed'));
    });
  }

  /* ================= скачивание фильма (гость) ================= */

  function downloadFilm() {
    if (!movie || movie.status !== 'ready' || downloading) return;
    downloading = true;
    $('dl').disabled = true;
    var parts = [];
    var got = 0;
    var chain = Promise.resolve();
    for (var i = 0; i < movie.chunks; i++) {
      (function (idx) {
        chain = chain.then(function () {
          return sb.storage.from(BUCKET).download(code + '/' + movie.id + '/' + idx)
            .then(function (r) {
              if (r.error) throw r.error;
              parts.push(r.data);
              got += r.data.size;
              setBar(got / movie.size);
              $('pct').textContent = Math.round((got / movie.size) * 100) + '% · ' +
                fmtBytes(got) + ' ' + T('of') + ' ' + fmtBytes(movie.size);
            });
        });
      })(i);
    }
    chain.then(function () {
      var blob = new Blob(parts, { type: movie.mime || 'video/mp4' });
      if (localUrl) { try { URL.revokeObjectURL(localUrl); } catch (e) {} }
      localUrl = URL.createObjectURL(blob);
      downloadedFor = movie.id;
      downloading = false;
      $('dl').disabled = false;
      bindPlayer();
      toast(T('downloaded'));
      send('need', {});   // фильм на месте — просим хоста подвести позицию
    }).catch(function (e) {
      downloading = false;
      $('dl').disabled = false;
      toast((e && e.message) || 'download failed');
    });
  }

  /* ================= состояние фильма ================= */

  function setBar(p) { $('bar').style.width = Math.max(0, Math.min(1, p || 0)) * 100 + '%'; }

  function renderStatus() {
    if (role === 'A') {
      if (!movie && !localUrl) { show('status', false); return; }
      if (!movie) return;
      show('status', true);
      $('status-title').textContent = movie.name || T('film');
      if (movie.status === 'uploading') {
        $('status-text').textContent = T('uploading') + '…';
        setBar(movie.size ? (movie.received || 0) / movie.size : 0);
        $('pct').textContent = Math.round(((movie.received || 0) / (movie.size || 1)) * 100) + '% · ' +
          fmtBytes(movie.received || 0) + ' ' + T('of') + ' ' + fmtBytes(movie.size || 0);
      } else if (movie.status === 'ready') {
        $('status-text').textContent = T('ready') + '.';
        setBar(1);
        $('pct').textContent = fmtBytes(movie.size) + ' · ' + movie.chunks + ' × 45 ' + T('mb');
      } else {
        $('status-text').textContent = T('upload_failed');
      }
      return;
    }
    // гость
    show('status', true);
    if (!movie) {
      $('status-title').textContent = T('film');
      $('status-text').textContent = T('no_file');
      $('pct').textContent = '';
      setBar(0);
      show('dl', false);
      return;
    }
    $('status-title').textContent = movie.name || T('film');
    if (movie.status === 'uploading') {
      $('status-text').textContent = T('uploading') + '…';
      setBar(movie.size ? (movie.received || 0) / movie.size : 0);
      $('pct').textContent = Math.round(((movie.received || 0) / (movie.size || 1)) * 100) + '%';
      show('dl', false);
      return;
    }
    if (movie.status === 'ready') {
      if (downloadedFor === movie.id) {
        $('status-text').textContent = T('downloaded') + '.';
        setBar(1);
        $('pct').textContent = fmtBytes(movie.size);
        show('dl', false);
      } else if (!downloading) {
        $('status-text').textContent = T('ready') + '.';
        setBar(0);
        $('pct').textContent = fmtBytes(movie.size) +
          (movie.chunks > 1 ? ' · ' + movie.chunks + ' ' + T('parts') : '');
        show('dl', true);
      }
      return;
    }
    $('status-text').textContent = T('reupload');
  }

  /* ================= синхронизация =================
   *
   * ЧАСЫ ХОСТА — единая шкала. Каждый пакет несёт n = Date.now() хоста в
   * момент отправки. Гость знает, насколько позиция УСТАРЕЛА, не имея общих
   * часов: у телефонов они и так выровнены по NTP, а по data channel возраст
   * пакета — единицы миллисекунд.
   */

  function sendSync(a, anchor) {
    if (role !== 'A' || !playerReady) return;
    var v = $('video');
    var t = Number(v.currentTime || 0);
    var paused = v.paused ? 1 : 0;
    var n = Date.now();
    var pkt = { a: a, t: +t.toFixed(3), p: paused, q: anchor ? 1 : 0, n: n };
    var open = !!(dc && dc.readyState === 'open');

    if (open) {
      try { dc.send(JSON.stringify({ k: 's', a: a, t: +t.toFixed(3), p: paused, q: anchor ? 1 : 0, n: n })); }
      catch (e) { open = false; }
    }
    if (!open || n - lastHttpSync > 2500) {
      lastHttpSync = n;
      send('sync', pkt);
    }
  }

  /* ЯКОРЬ — не сердцебиение. Нужен ровно для того, чтобы вошедший посреди
   * фильма сразу попал в кадр. Идущего гостя он НЕ двигает. */
  function startAnchor() {
    if (anchorInt) clearInterval(anchorInt);
    anchorInt = setInterval(function () {
      if (role !== 'A' || !playerReady || !peerHere) return;
      var v = $('video');
      if (v.paused) return;
      sendSync('play', 1);
    }, 4000);
  }

  function pushState() {
    if (role !== 'A' || !playerReady) return;
    lastHttpSync = 0;
    var v = $('video');
    sendSync(v.paused ? 'pause' : 'play', false);
  }

  function applySync(s) {
    if (!s) return;
    var stamp = Number(s.n || 0);
    if (stamp && stamp <= lastSyncAt) return;   // устаревший или дубль не применяем
    if (stamp) lastSyncAt = stamp;

    var t = Number(s.t) || 0;
    var paused = !!Number(s.p);
    var anchor = !!Number(s.q);
    var sentAt = Number(s.n || 0);
    var age = sentAt ? (Date.now() - sentAt) / 1000 : 0;
    if (!isFinite(age) || age < 0 || age > 60) age = 0;

    hostState = { t: t + age, at: nowMs(), p: paused };

    if (role !== 'B' || !playerReady) return;
    var v = $('video');
    var cur = Number(v.currentTime || 0);

    if (s.a === 'pause') {
      if (Math.abs(cur - t) > 0.35) v.currentTime = t;
      if (!v.paused) v.pause();
      return;
    }

    var target = paused ? t : t + age;

    /* Якорь не команда: подводим только того, кто вошёл недавно, и аварию.
     * Идущего гостя не трогаем — позицию выправит скорость (rateLoop). */
    if (anchor) {
      var fresh = justJoinedAt && (nowMs() - justJoinedAt) < 8000;
      if (fresh || Math.abs(cur - target) > 2.5) {
        justJoinedAt = 0;
        if (Math.abs(cur - target) > 0.1) v.currentTime = target;
        if (paused) { if (!v.paused) v.pause(); }
        else if (v.paused) v.play().catch(function () {});
        return;
      }
      if (!paused && v.paused) v.play().catch(function () {});
      return;
    }

    // Явная команда (play/seek): подводим один раз, дальше — скоростью.
    justJoinedAt = 0;
    if (s.a === 'seek') {
      if (Math.abs(cur - target) > 0.12) v.currentTime = target;
    } else if (Math.abs(cur - target) > 0.45) {
      v.currentTime = target;
    }
    if (paused) { if (!v.paused) v.pause(); }
    else if (v.paused) v.play().catch(function () {});
  }

  /* ЭЛИТА: СКОРОСТЬ ВМЕСТО ПРЫЖКОВ.
   * Каждые 250 мс гость смотрит, где должен быть хост, и подстраивает
   * playbackRate. 1 с расхождения = ±5% скорости, то есть ~0.05 c за такт,
   * и это ещё мягче, чем нужно: слышимый предел — около 7%. Как только
   * расхождение меньше 40 мс, скорость возвращается ровно к 1. */
  function startRateLoop() {
    if (rateInt) clearInterval(rateInt);
    rateInt = setInterval(function () {
      var v = $('video');
      if (role !== 'B' || !playerReady || !hostState) { try { v.playbackRate = 1; } catch (e) {} return; }
      if (v.paused || hostState.p) { try { v.playbackRate = 1; } catch (e) {} return; }

      var target = hostState.t + (nowMs() - hostState.at) / 1000;
      var cur = Number(v.currentTime || 0);
      var err = target - cur;              // >0 — мы отстали

      if (Math.abs(err) > 2.0) {           // авария: тут прыжок дешевле
        v.currentTime = target;
        try { v.playbackRate = 1; } catch (e) {}
        return;
      }
      var rate = 1;
      if (Math.abs(err) > 0.04) rate = 1 + Math.max(-0.06, Math.min(0.06, err * 0.5));
      try {
        if (Math.abs(v.playbackRate - rate) > 0.005) v.playbackRate = rate;
      } catch (e) {}
    }, 250);
  }

  /* Цифра расхождения — только показ, без вмешательства. */
  setInterval(function () {
    var el = $('drift');
    if (!el || role !== 'B' || !playerReady) return;
    var v = $('video');
    if (!hostState || hostState.p || v.paused) { el.textContent = ''; return; }
    var target = hostState.t + (nowMs() - hostState.at) / 1000;
    var d = target - (v.currentTime || 0);
    el.textContent = Math.abs(d) < 0.35
      ? T('synced') + ' · ' + v.playbackRate.toFixed(3) + '×'
      : (d > 0 ? '−' : '+') + Math.abs(d).toFixed(2) + ' ' + T('away');
  }, 1000);

  /* ================= пульт ================= */

  function canControl() { return role === 'A' || (role === 'B' && grantOn); }

  function syncControls() {
    var locked = !canControl();
    $('play').disabled = locked;
    $('seek').disabled = locked;
    show('plock', locked && role === 'B');
    $('grant-label').textContent = grantOn ? T('guest_ctrl') : T('host_ctrl');
    $('grant').classList.toggle('on', grantOn);
    if (role !== 'A') $('grant').classList.toggle('lock', !grantOn);
    $('grant').disabled = role !== 'A';
  }

  function setGrant(v, quiet) {
    if (grantOn === !!v) return;
    grantOn = !!v;
    syncControls();
    if (!quiet && role === 'A') send('grant', { on: grantOn });
  }

  function sendCtrl(a) {
    if (!canControl() || !playerReady) return;
    var v = $('video');
    if (role === 'A') { sendSync(a, false); return; }
    // Гость с правом управления просит хоста: тот выполнит у себя и разошлёт
    // обычную синхронизацию — дальше всё как всегда.
    send('ctrl', { from: 'B', a: a, t: +Number(v.currentTime || 0).toFixed(3), p: v.paused ? 1 : 0, n: Date.now() });
  }

  function runCtrl(o) {
    if (!o) return;
    var n = Number(o.n) || 0;
    if (n && n <= lastCtrlN) return;
    lastCtrlN = n;
    var v = $('video');
    if (o.a === 'seek') v.currentTime = Number(o.t) || 0;
    else if (o.a === 'play') v.play().catch(function () {});
    else if (o.a === 'pause') v.pause();
    sendSync(o.a, false);
  }

  /* ================= голос (без «звонка») ================= */

  function makeSilentTrack() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      silentCtx = new AC();
      if (silentCtx.state === 'suspended') silentCtx.resume().catch(function () {});
      var dst = silentCtx.createMediaStreamDestination();
      var src = silentCtx.createOscillator();
      var g = silentCtx.createGain();
      g.gain.value = 0;
      src.connect(g); g.connect(dst); src.start();
      return dst.stream.getAudioTracks()[0];
    } catch (e) { return null; }
  }

  function startVoice() {
    if (!voiceTimers) {
      voiceTimers = [
        // Пока соединение не поднялось, хост раз в 1.5 с пробует предложить SDP.
        setInterval(function () { if (!pc || connected || dcon) return; if (role === 'A') maybeOffer(); }, 1500),
        // Гость тем временем напоминает о себе — на случай, если offer потерялся.
        setInterval(function () { if (!pc || connected || dcon) return; if (role === 'B') send('need', {}); }, 4000)
      ];
    }
    if (!pc) buildPeer();
  }

  /* Сборка отложена до turnReady, поэтому повторный вызов успел бы создать
   * ВТОРОЙ RTCPeerConnection — держим флаг на время ожидания. */
  function buildPeer() {
    if (pc || pcBuilding) return;
    pcBuilding = true;
    turnReady.then(function () { pcBuilding = false; buildPeerNow(); });
  }

  function buildPeerNow() {
    if (!me) return;
    try { pc = new RTCPeerConnection({ iceServers: STUN.concat(TURN), iceCandidatePoolSize: 4 }); }
    catch (e) { pc = null; return; }

    // «Тихая» дорожка кладётся в соединение сразу: включение микрофона — это
    // replaceTrack на живом соединении, без нового SDP и нового ICE.
    silentTrack = makeSilentTrack();
    if (silentTrack) {
      try { audioSender = pc.addTrack(silentTrack, new MediaStream([silentTrack])); } catch (e) {}
    }
    if (micTrack && audioSender) { try { audioSender.replaceTrack(micTrack); } catch (e) {} }

    pc.ontrack = function (ev) {
      var a = $('remote');
      if (ev.streams && ev.streams[0] && a.srcObject !== ev.streams[0]) {
        a.srcObject = ev.streams[0];
        a.play().catch(function () {});
      }
    };
    pc.onicecandidate = function (ev) {
      if (ev.candidate) send('sig', { kind: 'ice', c: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = function () {
      connected = !!(pc && pc.connectionState === 'connected');
      renderPeople();
      if (pc && pc.connectionState === 'failed') peerGone();
    };

    if (role === 'A') {
      try { dc = pc.createDataChannel('ksu', { ordered: true }); bindDc(); } catch (e) {}
    } else {
      pc.ondatachannel = function (ev) { dc = ev.channel; bindDc(); };
    }
  }

  function bindDc() {
    if (!dc) return;
    dc.onopen = function () { dcon = true; renderPeople(); };
    dc.onclose = function () { dcon = false; renderPeople(); };
    dc.onmessage = function (ev) {
      var o = null;
      try { o = JSON.parse(ev.data); } catch (e) { return; }
      if (!o) return;
      if (o.k === 's' && role === 'B') applySync({ a: o.a, t: o.t, p: o.p, q: o.q, n: o.n });
      else if (o.k === 'c' && role === 'A') runCtrl({ a: o.a, t: o.t, p: o.p, n: o.n });
    };
  }

  function onSignal(pl) {
    if (!pl) return;
    if (pl.kind === 'offer') onOffer(pl);
    else if (pl.kind === 'answer') onAnswer(pl);
    else if (pl.kind === 'ice') onIce(pl);
  }

  function maybeOffer() {
    if (!pc || role !== 'A' || connected || dcon) return;
    if (pc.signalingState !== 'stable') return;
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
      send('sig', { kind: 'offer', sdp: pc.localDescription.sdp });
    }).catch(function () {});
  }

  function onOffer(o) {
    if (!pc || !o.sdp) return;
    pc.setRemoteDescription({ type: 'offer', sdp: o.sdp }).then(function () {
      return pc.createAnswer();
    }).then(function (a) {
      return pc.setLocalDescription(a);
    }).then(function () {
      send('sig', { kind: 'answer', sdp: pc.localDescription.sdp });
    }).catch(function () {});
  }

  function onAnswer(o) {
    if (!pc || !o.sdp || pc.signalingState !== 'have-local-offer') return;
    pc.setRemoteDescription({ type: 'answer', sdp: o.sdp }).catch(function () {});
  }

  function onIce(o) {
    if (!o.c || !pc) return;
    pc.addIceCandidate(o.c).catch(function () {});
  }

  function toggleMic() {
    if (micOn) {
      micOn = false;
      if (micTrack) { try { micTrack.stop(); } catch (e) {} micTrack = null; }
      if (silentTrack && audioSender) { try { audioSender.replaceTrack(silentTrack); } catch (e) {} }
    } else {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
        micTrack = st.getAudioTracks()[0];
        micOn = true;
        if (audioSender) { try { audioSender.replaceTrack(micTrack); } catch (e) {} }
        renderMic();
      }).catch(function () { toast(T('no_mic')); });
    }
    renderMic();
  }

  function renderMic() {
    $('mic-label').textContent = micOn ? T('mic_on') : T('mic_off');
    $('mic').classList.toggle('on', micOn);
  }

  /* ================= проигрыватель ================= */

  function bindPlayer() {
    var v = $('video');
    if (!localUrl) return;
    v.src = localUrl;
    show('player', true);
    show('pick', false);
    playerReady = true;
    v.load();
    if (playerBound) { syncControls(); return; }
    playerBound = true;

    // Гость входит в фильм — подводим позицию один раз.
    if (role === 'B') justJoinedAt = nowMs();
    v.addEventListener('loadedmetadata', function () {
      $('dur').textContent = fmtTime(v.duration);
      $('seek').max = v.duration || 0;
    });
    v.addEventListener('timeupdate', function () {
      if (v.seeking) return;
      $('cur').textContent = fmtTime(v.currentTime);
      $('seek').value = v.currentTime;
    });
    v.addEventListener('play', function () { $('play').querySelector('.i-play').classList.add('hidden'); $('play').querySelector('.i-pause').classList.remove('hidden'); });
    v.addEventListener('pause', function () { $('play').querySelector('.i-play').classList.remove('hidden'); $('play').querySelector('.i-pause').classList.add('hidden'); });
    v.addEventListener('error', function () { toast(T('not_supported')); });
    $('vol').addEventListener('input', function () { v.volume = Number(this.value); });
    syncControls();
  }

  $('play').addEventListener('click', function () {
    if (!canControl()) return;
    var v = $('video');
    if (v.paused) { v.play().catch(function () {}); sendCtrl('play'); }
    else { v.pause(); sendCtrl('pause'); }
  });

  $('seek').addEventListener('input', function () {
    if (!canControl()) return;
    $('video').currentTime = Number(this.value);
  });
  $('seek').addEventListener('change', function () {
    if (!canControl()) return;
    $('video').currentTime = Number(this.value);
    sendCtrl('seek');
  });

  $('full').addEventListener('click', function () {
    var w = $('video').parentNode;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (w.requestFullscreen) w.requestFullscreen();
      else if (w.webkitRequestFullscreen) w.webkitRequestFullscreen();
    } catch (e) {}
  });

  $('grant').addEventListener('click', function () {
    if (role !== 'A') return;
    setGrant(!grantOn);
    toast(grantOn ? T('guest_ctrl') : T('host_ctrl'));
  });

  $('mic').addEventListener('click', toggleMic);

  $('copy').addEventListener('click', function () {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(code);
      else {
        var t = document.createElement('textarea');
        t.value = code; document.body.appendChild(t); t.select();
        document.execCommand('copy'); document.body.removeChild(t);
      }
      toast(T('copied'));
    } catch (e) {}
  });

  $('leave').addEventListener('click', function () {
    send('bye', {});
    leaveRoom();
    location.replace('./');
  });

  function leaveRoom() {
    try { if (roomCh) sb.removeChannel(roomCh); } catch (e) {}
    roomCh = null;
  }

  $('create').addEventListener('click', createRoom);
  $('join').addEventListener('click', joinRoom);
  $('joincode').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });
  $('file').addEventListener('change', function () { if (this.files && this.files[0]) pickFile(this.files[0]); });
  $('dl').addEventListener('click', downloadFilm);
  $('lang').addEventListener('click', function () {
    lang = lang === 'ru' ? 'en' : 'ru';
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    location.reload();
  });

  window.addEventListener('pagehide', function () { try { send('bye', {}); leaveRoom(); } catch (e) {} });

  /* ================= старт ================= */

  applyLang();
  startMoviePoll();
  $('joincode').placeholder = T('code_ph');

  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (!s || !s.user) { location.replace('./'); return; }
    return sb.from('profiles').select('id,username,phone').eq('id', s.user.id).maybeSingle()
      .then(function (pr) { me = pr.data || { id: s.user.id, username: '' }; });
  }).then(function () {
    if (!me) return;
    renderMic();
    if (code && role) enterRoom();
  }).catch(function () { location.replace('./'); });
})();
