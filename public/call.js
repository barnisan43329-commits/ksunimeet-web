/* KsuNiMeet — экран звонка (голос/видео) поверх Supabase.
 *
 * Механика ровно та же, что была на своём сервере, но без сервера-посредника:
 *   • строка в таблице `calls` — это и «звонок идёт», и «кто звонит», и
 *     «приняли/отклонили/пропустили»; истечение делает сама база (27 с);
 *   • сигналинг WebRTC (offer/answer/ICE) летит через Broadcast канала
 *     комнаты, — то есть push, а не опрос каждую секунду.
 *
 * ПОЧЕМУ BROADCAST, А НЕ ТАБЛИЦА room_events:
 *   На этом проекте постгресовые подписки (postgres_changes) не доставляют
 *   ничего для таблиц с включённым RLS — проверено и с service_role, и с
 *   политикой using(true): при RLS off события идут, при RLS on молча
 *   пропадают. Broadcast той же Realtime-службы работает и через проверку
 *   строк не проходит. Поэтому сигналинг идёт broadcast'ом, а состояние
 *   звонка и состояние разговора дополнительно перечитываются из `calls`
 *   раз в 2 с — на случай, если адресат был не в сети в момент рассылки.
 *
 * ГОНКА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ: звонящий добавляет дорожки и отправляет
 * offer сразу, а принимающий подписывается на комнату только после нажатия
 * «ответить». Раньше offer в этот момент уже улетал (и терялся) — теперь
 * звонящий повторяет offer, пока не получит answer.
 *
 * Голос/видео идут НАПРЯМУЮ между устройствами (P2P). Если сеть не даст
 * прямой путь, нужен TURN — см. turn.js.
 */
(function () {
  'use strict';

  var CFG = window.KSU_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var callId = q.get('call') || '';
  var video = q.get('video') === '1';
  var isCaller = q.get('out') === '1';
  // Трубку могли поднять ЕЩЁ НА ЭКРАНЕ ВХОДЯЩЕГО (в приложении так делает и
  // нативная активность). Тогда второй вопрос «ответить?» уже лишний.
  var preAccepted = q.get('accepted') === '1';
  var LANG_KEY = 'ksu_lang';

  var lang = (function () {
    try { var s = localStorage.getItem(LANG_KEY); if (s === 'ru' || s === 'en') return s; } catch (e) {}
    return /^(ru|be|uk|kk)/.test((navigator.language || '').toLowerCase()) ? 'ru' : 'en';
  })();
  var L = {
    ru: {
      title: 'Звонок', calling: 'Вызов…', ringing: 'Звонит…', connecting: 'Соединяемся…',
      live: 'Соединение установлено', peer: 'Собеседник',
      ended: 'Звонок завершён', missed: 'Пропущенный звонок', declined: 'Звонок отклонён',
      noanswer: 'Не ответили', nosignal: 'Соединение не установилось — возможно, нужен TURN',
      calling_hint: 'Ждём, пока ответят.', ringing_hint: 'Ответить или отклонить.',
      peer_left: 'Собеседник вышел',
      no_media: 'Нет доступа к камере/микрофону',
      answer: 'Ответить', decline: 'Отклонить', hang_up: 'Завершить',
      minimize: 'Свернуть в приложение', mute_mic: 'Микрофон',
      camera: 'Камера', flip_cam: 'Перевернуть камеру'
    },
    en: {
      title: 'Call', calling: 'Calling…', ringing: 'Ringing…', connecting: 'Connecting…',
      live: 'Connected', peer: 'Peer',
      ended: 'Call ended', missed: 'Missed call', declined: 'Call declined',
      noanswer: 'No answer', nosignal: 'Could not connect — TURN may be required',
      calling_hint: 'Waiting for an answer.', ringing_hint: 'Answer or decline.',
      peer_left: 'Peer left',
      no_media: 'No camera/microphone access',
      answer: 'Answer', decline: 'Decline', hang_up: 'Hang up',
      minimize: 'Minimize to the app', mute_mic: 'Microphone',
      camera: 'Camera', flip_cam: 'Flip camera'
    }
  };
  function T(k) { return (L[lang] && L[lang][k]) || L.ru[k] || k; }

  /* Надписи из разметки: data-i18n / data-i18n-aria. В html перевода нет. */
  function applyLang() {
    var i, els;
    els = document.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) els[i].textContent = T(els[i].getAttribute('data-i18n'));
    els = document.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-i18n-aria');
      els[i].setAttribute('aria-label', T(k));
      if (els[i].hasAttribute('title')) els[i].setAttribute('title', T(k));
    }
    try { document.documentElement.lang = lang; } catch (e) {}
    document.title = T('title') + ' · KsuNiMeet';
  }

  if (!CFG.supabaseUrl || !window.supabase) {
    applyLang();
    document.body.innerHTML = '<main><div class="who"><div class="phase">' + T('nosignal') + '</div></div></main>';
    return;
  }

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ksu-auth' },
    // Дедлайн и повтор на каждый запрос (net.js) — экран звонка не должен
    // «висеть» на середине обмена SDP на обрывающемся канале.
    global: { fetch: (window.KSU_NET && window.KSU_NET.fetch) || undefined }
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

  var me = null;          // {id, username, phone}
  var peer = null;        // профиль собеседника
  var call = null;        // строка calls
  var room = null;        // код комнаты сигналинга
  var pc = null, pcBuilding = false;
  var localStream = null;
  var micOn = true, camOn = video, facing = 'user';
  var live = false, done = false;
  var tickInt = null, startedAt = 0;
  var chRoom = null;
  var pendingIce = [];
  var offerRetryInt = null, callPollInt = null;

  function show(id, on) { var e = $(id); if (e) e.classList.toggle('hidden', !on); }
  function setPhase(t) { $('phase').textContent = t || ''; }
  function setNote(t) { $('ring-note').textContent = t; $('live-note').textContent = t; }
  function setNet(t) { $('net').textContent = t || ''; }

  function renderWho() {
    var n = (peer && peer.username) || T('peer');
    $('ava').textContent = n.charAt(0).toUpperCase();
    $('name').textContent = n;
    $('phone').textContent = peer && peer.phone ? peer.phone : '';
  }

  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60); s = s % 60;
    return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2);
  }

  function stopTimers() {
    if (tickInt) { clearInterval(tickInt); tickInt = null; }
    if (offerRetryInt) { clearInterval(offerRetryInt); offerRetryInt = null; }
    if (callPollInt) { clearInterval(callPollInt); callPollInt = null; }
  }

  /* ================= завершение ================= */

  function finish(reason) {
    if (done) return;
    done = true;
    stopTimers();
    try { if (pc) pc.close(); } catch (e) {}
    pc = null;
    try { if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    localStream = null;
    try { if (chRoom) sb.removeChannel(chRoom); } catch (e) {}
    chRoom = null;
    $('who').classList.add('gone');
    show('phase-live', false);
    show('phase-ring', false);
    show('local', false);
    setPhase(T(reason || 'ended'));
    // Сообщаем приложению (и нативному APK), что звонок кончился: свернуть
    // звонок в «мини-бар» больше некуда — возвращаемся сами.
    try {
      if (window.KsuNiMeet && window.KsuNiMeet.inCall) window.KsuNiMeet.inCall(false);
    } catch (e) {}
    setTimeout(function () {
      try { if (window.history.length > 1) window.history.back(); else location.replace('./'); }
      catch (e) { location.replace('./'); }
    }, 1400);
  }

  function hang() {
    var next = live ? 'ended' : (isCaller ? 'cancelled' : 'declined');
    try { if (call && !done) setCallState(next); } catch (e) {}
    finish(live ? 'ended' : (isCaller ? 'ended' : 'declined'));
  }

  /* ================= сигналинг ================= */

  function signal(kind, data) {
    if (!room || !chRoom) return;
    var payload = { kind: kind };
    if (data) for (var k in data) payload[k] = data[k];
    try { chRoom.send({ type: 'broadcast', event: 'sig', payload: payload }); } catch (e) {}
  }

  /* Состояние звонка живёт в строке `calls` (её читает и нативный APK, и
   * входящий экран в приложении). Дополнительно сообщаем о смене по
   * broadcast — чтобы собеседник узнал мгновенно, а не на следующем тике. */
  function setCallState(state) {
    if (!call) return;
    sb.from('calls').update({ state: state }).eq('id', call.id).then(function () {}, function () {});
    if (chRoom) {
      try { chRoom.send({ type: 'broadcast', event: 'state', payload: { state: state } }); } catch (e) {}
    }
  }

  function onPeerState(state) {
    if (!state || done) return;
    if (state === 'answered') return;   // медиа поднимется сама
    if (state === 'declined') { finish(isCaller ? 'declined' : 'ended'); return; }
    if (state === 'cancelled' || state === 'ended' || state === 'missed') {
      finish(state === 'missed' ? 'missed' : 'ended');
    }
  }

  /* Подстраховка: адресат мог быть не в сети в момент broadcast'а, а база
   * всё помнит. Раз в 2 с, пока звонок не в разговоре, сверяемся со строкой. */
  function startCallPoll() {
    if (callPollInt) clearInterval(callPollInt);
    callPollInt = setInterval(function () {
      if (done || live || !call) return;
      sb.from('calls').select('state').eq('id', call.id).maybeSingle().then(function (r) {
        if (r.data && r.data.state) onPeerState(r.data.state);
      });
    }, 2000);
  }

  /* ================= WebRTC ================= */

  function media() {
    var want = { audio: true, video: !!camOn };
    if (camOn) want.video = { facingMode: facing };
    return navigator.mediaDevices.getUserMedia(want).then(function (st) {
      localStream = st;
      $('local').srcObject = st;
      show('local', camOn);
      return st;
    });
  }

  /* Сборка отложена до turnReady, поэтому повторный вызов успел бы создать
   * ВТОРОЙ RTCPeerConnection — держим флаг на время ожидания. */
  function buildPeer(st) {
    if (pc || pcBuilding) return;
    pcBuilding = true;
    turnReady.then(function () { pcBuilding = false; buildPeerNow(st); });
  }

  function buildPeerNow(st) {
    if (done) return;
    pc = new RTCPeerConnection({ iceServers: STUN.concat(TURN), iceCandidatePoolSize: 4 });
    st.getTracks().forEach(function (t) { pc.addTrack(t, st); });

    pc.ontrack = function (ev) {
      var v = $('remote');
      if (ev.streams && ev.streams[0] && v.srcObject !== ev.streams[0]) {
        v.srcObject = ev.streams[0];
        v.classList.add('on');
        $('who').classList.add('gone');
      }
    };
    pc.onicecandidate = function (ev) {
      if (ev.candidate) signal('ice', { c: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = function () {
      var s = pc ? pc.connectionState : 'closed';
      if (s === 'connected') {
        if (!live) {
          live = true;
          startedAt = Date.now();
          if (offerRetryInt) { clearInterval(offerRetryInt); offerRetryInt = null; }
          show('phase-ring', false);
          show('phase-live', true);
          setPhase('');
          setNote('');
          if (tickInt) clearInterval(tickInt);
          tickInt = setInterval(function () {
            $('timer').textContent = fmtElapsed(Date.now() - startedAt);
          }, 500);
          // Системная телефония в APK: разговор начался (wake lock, «Идёт звонок»)
          try { if (window.KsuNiMeet && window.KsuNiMeet.inCall) window.KsuNiMeet.inCall(true); } catch (e) {}
        }
      } else if (s === 'failed') {
        setPhase(T('nosignal'));
      }
    };

    if (isCaller) {
      pc.onnegotiationneeded = function () { maybeOffer(); };
      // Пока ответа нет — повторяем offer. Принимающий подписывается на
      // комнату только после «ответить», и первый offer легко улетает в пустоту.
      offerRetryInt = setInterval(maybeOffer, 2000);
    }
  }

  function maybeOffer() {
    if (!pc || !isCaller || done || live) return;
    if (pc.currentRemoteDescription) return;          // answer уже получен
    if (pc.signalingState !== 'stable') return;
    pc.createOffer().then(function (o) {
      return pc.setLocalDescription(o);
    }).then(function () {
      signal('offer', { sdp: pc.localDescription.sdp });
    }).catch(function () {});
  }

  function onOffer(o) {
    if (!pc || !o.sdp) return;
    pc.setRemoteDescription({ type: 'offer', sdp: o.sdp }).then(function () {
      return pc.createAnswer();
    }).then(function (a) {
      return pc.setLocalDescription(a);
    }).then(function () {
      signal('answer', { sdp: pc.localDescription.sdp });
      flushIce();
    }).catch(function () {});
  }

  function onAnswer(o) {
    if (!pc || !o.sdp || pc.signalingState !== 'have-local-offer') return;
    pc.setRemoteDescription({ type: 'answer', sdp: o.sdp }).then(flushIce, function () {});
  }

  function onIce(o) {
    if (!o.c) return;
    if (!pc || !pc.remoteDescription) { pendingIce.push(o.c); return; }
    pc.addIceCandidate(o.c).catch(function () {});
  }

  function flushIce() {
    if (!pc) return;
    var q2 = pendingIce; pendingIce = [];
    q2.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
  }

  /* ================= канал комнаты ================= */

  function openRoom() {
    if (!room) return;
    chRoom = sb.channel('ksu-call-' + room)
      .on('broadcast', { event: 'sig' }, function (p) {
        var pl = p && p.payload;
        if (!pl) return;
        if (pl.kind === 'offer') onOffer(pl);
        else if (pl.kind === 'answer') onAnswer(pl);
        else if (pl.kind === 'ice') onIce(pl);
        else if (pl.kind === 'bye') finish('peer_left');
      })
      .on('broadcast', { event: 'state' }, function (p) {
        if (p && p.payload) onPeerState(p.payload.state);
      })
      .on('broadcast', { event: 'ready' }, function () {
        // Принимающий на связи и ждёт offer — можно предлагать сразу.
        if (isCaller) maybeOffer();
      })
      .subscribe(function (status) {
        if (status !== 'SUBSCRIBED') return;
        if (!isCaller) signal('ready', {});
      });
  }

  /* ================= принятие ================= */

  function accept() {
    show('btn-accept', false);
    show('btn-decline', true);
    setNote('');
    setPhase(T('connecting'));
    setCallState('answered');
    startMedia();
  }

  function startMedia() {
    media().then(function (st) {
      buildPeer(st);
      // Принимающий только что вошёл — говорим звонящему, что можно предлагать.
      if (!isCaller) signal('ready', {});
    }).catch(function () {
      setPhase(T('no_media'));
    });
  }

  /* ================= старт ================= */

  applyLang();
  renderWho();

  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (!s || !s.user) { location.replace('./'); return; }
    me = { id: s.user.id };
    return sb.from('profiles').select('id,username,phone').eq('id', s.user.id).maybeSingle()
      .then(function (pr) { if (pr.data) me = pr.data; });
  }).then(function () {
    if (!callId) {
      setPhase(T('nosignal'));
      return;
    }
    return sb.from('calls').select('*').eq('id', callId).maybeSingle().then(function (r) {
      call = r.data;
      if (!call) { setPhase(T('ended')); setTimeout(function () { location.replace('./'); }, 1200); return; }
      video = !!call.video || video;
      camOn = camOn || video;
      var peerId = call.caller_id === me.id ? call.callee_id : call.caller_id;
      isCaller = call.caller_id === me.id;
      room = call.room_code;

      return sb.from('profiles').select('id,username,phone').eq('id', peerId).maybeSingle()
        .then(function (pr) { peer = pr.data || null; });
    });
  }).then(function () {
    if (!call) return;
    renderWho();
    document.title = ((peer && peer.username) || 'KsuNiMeet') + ' · KsuNiMeet';

    show('cam-btn', video);
    show('flip-btn', video);
    openRoom();
    startCallPoll();

    if (isCaller) {
      show('btn-accept', false);
      show('btn-decline', true);
      setNote(T('calling_hint'));
      setPhase(T('calling'));
      startMedia();
    } else if (preAccepted || call.state === 'answered') {
      // Входящий, по которому уже ответили: сразу поднимаем медиа и идём в
      // разговор. Правим это и для нативного APK, который помечает звонок
      // answered до открытия страницы.
      show('btn-accept', false);
      show('btn-decline', true);
      setNote('');
      setPhase(T('connecting'));
      setCallState('answered');   // подстраховка: запись должна быть точной
      startMedia();
    } else {
      // Входящий: звоним и показываем «ответить / отклонить». Медиа не трогаем,
      // пока не ответят, — иначе камера загорится без согласия человека.
      show('btn-accept', true);
      show('btn-decline', true);
      setNote(T('ringing_hint'));
      setPhase(T('ringing'));
    }
  }).catch(function () {
    setPhase(T('nosignal'));
  });

  /* ================= кнопки ================= */

  $('btn-accept').addEventListener('click', accept);
  $('btn-decline').addEventListener('click', function () {
    if (call && !live) setCallState(isCaller ? 'cancelled' : 'declined');
    finish(isCaller ? 'ended' : 'declined');
  });
  $('hang-btn').addEventListener('click', hang);

  $('mic-btn').addEventListener('click', function () {
    micOn = !micOn;
    try { localStream.getAudioTracks().forEach(function (t) { t.enabled = micOn; }); } catch (e) {}
    this.classList.toggle('muted', !micOn);
  });

  $('cam-btn').addEventListener('click', function () {
    camOn = !camOn;
    this.classList.toggle('muted', !camOn);
    var vt = null;
    try { vt = localStream.getVideoTracks()[0] || null; } catch (e) {}
    if (!vt && camOn) {
      // Камеру выключили — дорожку убрали; включаем заново живой заменой.
      navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }).then(function (st) {
        var t = st.getVideoTracks()[0];
        if (!t || !pc) return;
        var sender = pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
        if (sender) sender.replaceTrack(t);
        else pc.addTrack(t, localStream);
        localStream.addTrack(t);
        $('local').srcObject = localStream;
        show('local', true);
      }).catch(function () {});
      return;
    }
    if (vt) vt.enabled = camOn;
    if (!camOn) show('local', false);
    else show('local', true);
  });

  $('flip-btn').addEventListener('click', function () {
    facing = facing === 'user' ? 'environment' : 'user';
    $('local').classList.toggle('flip', facing === 'user');
    if (!pc || !localStream) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }).then(function (st) {
      var t = st.getVideoTracks()[0];
      var old = localStream.getVideoTracks()[0];
      var sender = pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
      if (sender && t) sender.replaceTrack(t);
      if (old) { try { localStream.removeTrack(old); old.stop(); } catch (e) {} }
      if (t) localStream.addTrack(t);
      $('local').srcObject = localStream;
    }).catch(function () {});
  });

  $('min-btn').addEventListener('click', function () {
    // Свернуть — это уйти назад в приложение, не разрывая звонок: APK держит
    // WebView живым (KsuNiMeet.inCall), звук продолжается.
    try { if (window.history.length > 1) window.history.back(); else location.replace('./'); }
    catch (e) { location.replace('./'); }
  });

  window.addEventListener('pagehide', function () {
    try { if (!done) { signal('bye', {}); setCallState(live ? 'ended' : (isCaller ? 'cancelled' : 'declined')); } } catch (e) {}
  });
})();
