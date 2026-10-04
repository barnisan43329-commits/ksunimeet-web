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
 *   напрямую браузер↔браузер), и только если он ещё не поднялся — строка
 *   rooms.sync в базе, на которую подписан Realtime. Обе дороги несут ОДНУ
 *   шкалу времени (часы хоста), поэтому устаревший пакет никогда не откатит
 *   картинку назад.
 */
(function () {
  'use strict';

  var CFG = window.KSU_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);

  var lang = (function () {
    try { var s = localStorage.getItem('ksu_lang'); if (s === 'ru' || s === 'en') return s; } catch (e) {}
    return /^(ru|be|uk|kk)/.test((navigator.language || '').toLowerCase()) ? 'ru' : 'en';
  })();
  var L = {
    ru: {
      lobby_err: 'Код комнаты — 5 символов: буквы и цифры.',
      wait_host: 'Ждём хоста…', host_here: 'Хост в комнате', guest_here: 'Гость в комнате',
      uploading: 'Заливаю фильм в комнату', ready: 'Фильм готов — гость может скачать',
      downloading: 'Скачиваю фильм', downloaded: 'Фильм скачан — можно смотреть',
      no_file: 'Хост ещё не выбрал фильм.', pick_first: 'Выберите фильм.',
      guest_ctrl: 'Гость управляет', host_ctrl: 'Гость не управляет',
      mic_on: 'Микрофон вкл', mic_off: 'Микрофон выкл',
      synced: 'синхронно', away: 'расхождение', left: 'Собеседник вышел',
      dl_btn: 'Скачать фильм', copied: 'Код скопирован', leave: 'Выйти',
      not_supported: 'Этот файл браузер проиграть не сможет. Нужен MP4 (H.264) или WebM.',
      voice: 'Голос', link: 'задержка'
    },
    en: {
      lobby_err: 'A room code is 5 characters: letters and digits.',
      wait_host: 'Waiting for the host…', host_here: 'Host is in the room', guest_here: 'Guest is in the room',
      uploading: 'Uploading the film', ready: 'Film is ready — the guest can download',
      downloading: 'Downloading the film', downloaded: 'Film downloaded — ready to watch',
      no_file: 'The host has not picked a film yet.', pick_first: 'Pick a film.',
      guest_ctrl: 'Guest controls', host_ctrl: 'Host controls',
      mic_on: 'Mic on', mic_off: 'Mic off',
      synced: 'in sync', away: 'drift', left: 'Peer left',
      dl_btn: 'Download film', copied: 'Code copied', leave: 'Leave',
      not_supported: 'The browser cannot play this file. Use MP4 (H.264) or WebM.',
      voice: 'Voice', link: 'latency'
    }
  };
  function T(k) { return (L[lang] && L[lang][k]) || L.ru[k] || k; }

  if (!CFG.supabaseUrl || !window.supabase) return;
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ksu-auth' },
    realtime: { params: { eventsPerSecond: 20 } }
  });

  var ICE = [{ urls: [
    'stun:stun.cloudflare.com:3478',
    'stun:stun.nextcloud.com:443',
    'stun:stun.syncthing.net:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
  ] }].concat(window.KSU_TURN_SERVERS || []);

  var CHUNK = 45 * 1024 * 1024;   // предел бесплатного Supabase — 50 МБ на объект
  var BUCKET = 'ksu-films';

  var me = null;
  var code = (q.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var role = q.get('role') === 'B' ? 'B' : (q.get('role') === 'A' ? 'A' : null);

  var movie = null;            // rooms.movie
  var localUrl = null;
  var downloadedFor = null;    // id фильма, который уже лежит локально
  var playerReady = false;
  var uploading = false, downloading = false;
  var grantOn = false;
  var ctrlN = 0, lastCtrlN = 0;
  var peers = {};
  var pc = null, dc = null, dcon = false, connected = false;
  var audioSender = null, silentTrack = null, micTrack = null, silentCtx = null;
  var micOn = false;
  var hostState = null, lastSyncAt = 0;
  var justJoinedAt = 0;
  var roomCh = null, peerCh = null;
  var anchorInt = null, rateInt = null, peopleInt = null;
  var lastHttpSync = 0;

  function nowMs() { return window.performance ? performance.now() : Date.now(); }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var m = Math.floor(s / 60), ss = s % 60, h = Math.floor(m / 60);
    m = m % 60;
    return (h > 0 ? h + ':' + ('0' + m).slice(-2) : ('0' + m).slice(-2)) + ':' + ('0' + ss).slice(-2);
  }
  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' ГБ';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' МБ';
    if (b > 1024) return (b / 1024).toFixed(0) + ' КБ';
    return b + ' Б';
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
      if (r.error || !r.data) { err(lang === 'ru' ? 'Комната не найдена.' : 'Room not found.'); return; }
      if (r.data.host_id === me.id) { err(lang === 'ru' ? 'Это ваша комната — вы хост.' : 'That is your own room.'); return; }
      code = c; role = 'B';
      try { history.replaceState({}, {}, '?code=' + c + '&role=B'); } catch (e) {}
      enterRoom();
    });
  }

  function enterRoom() {
    show('lobby', false);
    show('room', true);
    $('rcode').textContent = code;
    show('pick', role === 'A');
    if (role === 'B') show('status', true);

    markPeer();
    subscribeRoom();
    loadRoom();      // фильм мог быть выбран ДО нашего входа — читаем состояние сразу
    subscribePeers();
    startVoice();
    startAnchor();
    startRateLoop();
    peopleInt = setInterval(markPeer, 4000);

    // Пока файл не готов — у гостя только «ждём»; хост может выбрать сразу.
    if (role === 'B') $('dl').textContent = T('dl_btn');
    syncControls();
    justJoinedAt = nowMs();
  }

  /* ================= «кто здесь» ================= */

  function markPeer() {
    if (!me || !code) return;
    sb.from('room_peers').upsert({
      room_code: code, role: role, user_id: me.id, name: me.username, seen_at: new Date().toISOString()
    }, { onConflict: 'room_code,role' }).then(function () {}, function () {});
  }

  function subscribePeers() {
    peerCh = sb.channel('ksu-peers-' + code)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'room_peers', filter: 'room_code=eq.' + code },
        function () { loadPeers(); })
      .subscribe();
    loadPeers();
  }

  function loadPeers() {
    sb.from('room_peers').select('role,name,seen_at,user_id').eq('room_code', code).then(function (r) {
      peers = {};
      var fresh = Date.now() - 15000;
      (r.data || []).forEach(function (p) {
        if (p.user_id === me.id) return;
        if (new Date(p.seen_at).getTime() < fresh) return;
        peers[p.role] = p;
      });
      renderPeople();
      // Хост увидел гостя — сразу отдаём точное состояние, не дожидаясь якоря.
      if (role === 'A' && peers['B'] && playerReady) pushState();
    });
  }

  function renderPeople() {
    var out = [];
    var other = peers[role === 'A' ? 'B' : 'A'];
    if (other) {
      out.push('<span class="person on"><span class="dot"></span>' +
        (role === 'A' ? T('guest_here') : T('host_here')) + ' · ' + esc(other.name || '') + '</span>');
    } else {
      out.push('<span class="person"><span class="dot"></span>' +
        (role === 'A' ? T('guest_here') : T('wait_host')) + '</span>');
    }
    if (connected) out.push('<span class="person on"><span class="dot"></span>' + T('voice') + '</span>');
    $('people').innerHTML = out.join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

    sb.from('rooms').update({ movie: m, sync: null, sync_seq: 0, ctrl: null, ctrl_seq: 0 })
      .eq('code', code).then(function () {}, function () {});
    movie = m;
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
          });
        });
      })(i);
    }
    chain.then(function () {
      m.status = 'ready';
      m.received = file.size;
      uploading = false;
      sb.from('rooms').update({ movie: m }).eq('code', code).then(function () {}, function () {});
      movie = m;
      renderStatus();
      toast(T('ready'));
    }).catch(function (e) {
      uploading = false;
      m.status = 'error';
      movie = m;
      renderStatus();
      toast((e && e.message) || 'upload failed');
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
                fmtBytes(got) + ' из ' + fmtBytes(movie.size);
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
      $('status-title').textContent = movie.name || 'Фильм';
      if (movie.status === 'uploading') {
        $('status-text').textContent = T('uploading') + ' — ' + T('guest_here').toLowerCase() + '.';
        setBar(movie.size ? (movie.received || 0) / movie.size : 0);
        $('pct').textContent = Math.round(((movie.received || 0) / (movie.size || 1)) * 100) + '% · ' +
          fmtBytes(movie.received || 0) + ' из ' + fmtBytes(movie.size || 0);
      } else if (movie.status === 'ready') {
        $('status-text').textContent = T('ready') + '.';
        setBar(1);
        $('pct').textContent = fmtBytes(movie.size) + ' · ' + movie.chunks + ' × 45 МБ';
      } else {
        $('status-text').textContent = lang === 'ru' ? 'Не удалось залить фильм.' : 'Upload failed.';
      }
      return;
    }
    // гость
    show('status', true);
    if (!movie) {
      $('status-title').textContent = 'Фильм';
      $('status-text').textContent = T('no_file');
      $('pct').textContent = '';
      setBar(0);
      show('dl', false);
      return;
    }
    $('status-title').textContent = movie.name || 'Фильм';
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
        $('pct').textContent = fmtBytes(movie.size) + ' · ' + movie.chunks + ' частей';
        show('dl', true);
      }
      return;
    }
    $('status-text').textContent = lang === 'ru' ? 'Хост заливает заново…' : 'Host is re-uploading…';
  }

  /* ================= подписки на комнату ================= */

  /* Начальное состояние комнаты. Без этого гость, вошедший после того как
   * хост выбрал фильм, видел пустоту: подписка приносит только НОВЫЕ
   * изменения, а выбор фильма уже случился. */
  function loadRoom() {
    sb.from('rooms').select('movie,sync,ctrl,ctrl_seq').eq('code', code).maybeSingle().then(function (r) {
      if (r.error || !r.data) return;
      var row = r.data;
      if (row.movie !== undefined) { movie = row.movie; renderStatus(); }
      if (role === 'B' && row.sync) applySync(row.sync);
      if (row.ctrl_seq) lastCtrlN = Math.max(lastCtrlN, row.ctrl_seq);
    });
  }

  function subscribeRoom() {
    roomCh = sb.channel('ksu-room-' + code)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'code=eq.' + code },
        function (p) {
          var row = p.new;
          if (!row) return;
          if (row.movie !== undefined) { movie = row.movie; renderStatus(); }
          if (row.ctrl !== undefined && role === 'A') {
            if (row.ctrl_seq && row.ctrl_seq <= lastCtrlN) { /* эхо своего же */ }
            else runCtrl(row.ctrl);
          }
          if (row.sync && role === 'B') applySync(row.sync);
          if (role === 'B' && row.ctrl_seq && row.ctrl_seq > lastCtrlN) {
            // Право управления: гость узнаёт о решении хоста мгновенно.
          }
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_events', filter: 'room_code=eq.' + code },
        function (p) {
          var row = p.new;
          if (!row || row.sender_id === me.id) return;
          var pl = row.payload || {};
          if (row.kind !== 'signal') return;
          if (pl.kind === 'offer') onOffer(pl);
          else if (pl.kind === 'answer') onAnswer(pl);
          else if (pl.kind === 'ice') onIce(pl);
          else if (pl.kind === 'bye') { toast(T('left')); hardReset(); }
          else if (pl.kind === 'need') needBack();
          else if (pl.kind === 'grant') setGrant(!!pl.on, true);
        })
      .subscribe();
  }

  function signal(kind, data) {
    if (!me) return;
    var payload = { kind: kind };
    if (data) for (var k in data) payload[k] = data[k];
    sb.from('room_events').insert({
      room_code: code, kind: 'signal', sender_id: me.id, payload: payload
    }).then(function () {}, function () {});
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
    var open = !!(dc && dc.readyState === 'open');

    if (open) {
      try { dc.send(JSON.stringify({ k: 's', a: a, t: +t.toFixed(3), p: paused, q: anchor ? 1 : 0, n: n })); }
      catch (e) { open = false; }
    }
    if (!open || n - lastHttpSync > 2500) {
      lastHttpSync = n;
      sb.from('rooms').update({
        sync: { a: a, t: +t.toFixed(3), p: paused, q: anchor ? 1 : 0, n: n },
        sync_seq: (lastSyncAt + 1)
      }).eq('code', code).then(function () {}, function () {});
    }
  }

  /* ЯКОРЬ — не сердцебиение. Нужен ровно для того, чтобы вошедший посреди
   * фильма сразу попал в кадр. Идущего гостя он НЕ двигает. */
  function startAnchor() {
    if (anchorInt) clearInterval(anchorInt);
    anchorInt = setInterval(function () {
      if (role !== 'A' || !playerReady || !peers['B']) return;
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
    if (stamp && stamp <= lastSyncAt) return;   // устаревший пакет не применяем
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
    if (!quiet && role === 'A') signal('grant', { on: grantOn });
  }

  function sendCtrl(a) {
    if (!canControl() || !playerReady) return;
    var v = $('video');
    var t = Number(v.currentTime || 0);
    var payload = { a: a, t: +t.toFixed(3), p: v.paused ? 1 : 0, n: Date.now() };
    ctrlN++;
    lastCtrlN = ctrlN;

    // Гость с правом управления отправляет команду хосту; хост выполняет её
    // у себя и рассылает обычную синхронизацию — дальше всё как всегда.
    if (role === 'B') {
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ k: 'c', a: a, t: +t.toFixed(3), p: v.paused ? 1 : 0, n: Date.now() })); }
        catch (e) {}
      }
      sb.from('rooms').update({ ctrl: payload, ctrl_seq: ctrlN }).eq('code', code)
        .then(function () {}, function () {});
      return;
    }
    // Хост: выполняем у себя и сразу рассылаем.
    runCtrl({ a: a, t: t, p: v.paused ? 1 : 0, seq: ctrlN });
  }

  function runCtrl(o) {
    if (!o || !o.seq || o.seq <= lastCtrlN) return;
    lastCtrlN = o.seq;
    var v = $('video');
    if (o.a === 'seek') { v.currentTime = Number(o.t) || 0; }
    else if (o.a === 'play') { v.play().catch(function () {}); }
    else if (o.a === 'pause') { v.pause(); }
    if (role === 'A') sendSync(o.a, false);
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
    if (pc) return;
    buildPeer();
    setInterval(function () { if (!pc || connected || dcon) return; if (role === 'A') maybeOffer(); }, 1500);
    setInterval(function () {
      if (!pc || connected || dcon) return;
      if (role === 'B') signal('relay', { kind: 'need' });
    }, 4000);
  }

  function buildPeer() {
    try { pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 4 }); }
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
      if (ev.candidate) signal('relay', { kind: 'ice', c: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = function () {
      connected = !!(pc && pc.connectionState === 'connected');
      renderPeople();
      if (pc && pc.connectionState === 'failed') hardReset();
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
      else if (o.k === 'c' && role === 'A') runCtrl({ a: o.a, t: o.t, p: o.p, seq: ++ctrlN });
    };
  }

  function maybeOffer() {
    if (!pc || role !== 'A' || connected || dcon) return;
    if (pc.signalingState !== 'stable') return;
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
      signal('relay', { kind: 'offer', sdp: pc.localDescription.sdp });
    }).catch(function () {});
  }

  function onOffer(o) {
    if (!pc || !o.sdp) return;
    pc.setRemoteDescription({ type: 'offer', sdp: o.sdp }).then(function () {
      return pc.createAnswer();
    }).then(function (a) {
      return pc.setLocalDescription(a);
    }).then(function () {
      signal('relay', { kind: 'answer', sdp: pc.localDescription.sdp });
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

  function needBack() {
    if (role !== 'A' || !pc || connected || dcon) return;
    if (pc.signalingState !== 'stable') { hardReset(); return; }
    maybeOffer();
  }

  function hardReset() {
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    pc = null; dc = null; dcon = false; connected = false;
    renderPeople();
    if (role === 'A') setTimeout(startVoice, 800);
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
      }).catch(function () { toast(lang === 'ru' ? 'Нет доступа к микрофону' : 'No microphone access'); });
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
    try { signal('bye', {}); } catch (e) {}
    sb.from('room_peers').delete().eq('room_code', code).eq('role', role).then(function () {}, function () {});
    location.replace('./');
  });

  $('create').addEventListener('click', createRoom);
  $('join').addEventListener('click', joinRoom);
  $('joincode').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });
  $('file').addEventListener('change', function () { if (this.files && this.files[0]) pickFile(this.files[0]); });
  $('dl').addEventListener('click', downloadFilm);
  $('lang').addEventListener('click', function () {
    lang = lang === 'ru' ? 'en' : 'ru';
    try { localStorage.setItem('ksu_lang', lang); } catch (e) {}
    location.reload();
  });

  window.addEventListener('pagehide', function () { try { signal('bye', {}); } catch (e) {} });

  /* ================= старт ================= */

  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (!s || !s.user) { location.replace('./'); return; }
    return sb.from('profiles').select('id,username,phone').eq('id', s.user.id).maybeSingle()
      .then(function (pr) { me = pr.data || { id: s.user.id, username: '' }; });
  }).then(function () {
    if (!me) return;
    $('joincode').placeholder = lang === 'ru' ? 'КОД' : 'CODE';
    renderMic();
    if (code && role) enterRoom();
  }).catch(function () { location.replace('./'); });
})();
