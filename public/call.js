/* KsuNiMeet — экран звонка (голос/видео) поверх Supabase.
 *
 * Механика ровно та же, что была на своём сервере, но без сервера-посредника:
 *   • строка в таблице `calls` — это и «звонок идёт», и «кто звонит», и
 *     «приняли/отклонили/пропустили»; истечение делает сама база (27 с);
 *   • сигналинг WebRTC (offer/answer/ICE) летит через `room_events`, на
 *     который подписан Realtime, — то есть push, а не опрос каждую секунду.
 *
 * Почему это «низкая задержка»: и решение о звонке, и обмен SDP/ICE приходят
 * событием, а не следующим тиком опроса. На прежнем сервере между «нажал
 * позвонить» и «у него зазвонило» стоял опрос до 2 с; здесь — один кадр.
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

  var lang = (function () {
    try { var s = localStorage.getItem('ksu_lang'); if (s === 'ru' || s === 'en') return s; } catch (e) {}
    return /^(ru|be|uk|kk)/.test((navigator.language || '').toLowerCase()) ? 'ru' : 'en';
  })();
  var L = {
    ru: {
      calling: 'Вызов…', ringing: 'Звонит…', connecting: 'Соединяемся…',
      live: 'Соединение установлено', peer: 'Собеседник',
      ended: 'Звонок завершён', missed: 'Пропущенный звонок', declined: 'Звонок отклонён',
      noanswer: 'Не ответили', nosignal: 'Соединение не установилось — возможно, нужен TURN',
      calling_hint: 'Ждём, пока ответят.', ringing_hint: 'Ответить или отклонить.',
      peer_left: 'Собеседник вышел'
    },
    en: {
      calling: 'Calling…', ringing: 'Ringing…', connecting: 'Connecting…',
      live: 'Connected', peer: 'Peer',
      ended: 'Call ended', missed: 'Missed call', declined: 'Call declined',
      noanswer: 'No answer', nosignal: 'Could not connect — TURN may be required',
      calling_hint: 'Waiting for an answer.', ringing_hint: 'Answer or decline.',
      peer_left: 'Peer left'
    }
  };
  function T(k) { return (L[lang] && L[lang][k]) || L.ru[k] || k; }

  if (!CFG.supabaseUrl || !window.supabase) {
    document.body.innerHTML = '<main><div class="who"><div class="phase">' + T('nosignal') + '</div></div></main>';
    return;
  }

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ksu-auth' }
  });

  var ICE = [{ urls: [
    'stun:stun.cloudflare.com:3478',
    'stun:stun.nextcloud.com:443',
    'stun:stun.syncthing.net:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
  ] }].concat(window.KSU_TURN_SERVERS || []);

  var me = null;          // {id, username, phone}
  var peer = null;        // профиль собеседника
  var call = null;        // строка calls
  var room = null;        // код комнаты сигналинга
  var pc = null;
  var localStream = null;
  var micOn = true, camOn = video, facing = 'user';
  var live = false, done = false;
  var tickInt = null, startedAt = 0;
  var chRoom = null, chCall = null;
  var pendingIce = [];
  var offerSentAt = 0, politeWait = false;

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

  /* ================= завершение ================= */

  function finish(reason) {
    if (done) return;
    done = true;
    if (tickInt) { clearInterval(tickInt); tickInt = null; }
    try { if (pc) pc.close(); } catch (e) {}
    pc = null;
    try { if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    localStream = null;
    try { if (chRoom) sb.removeChannel(chRoom); } catch (e) {}
    try { if (chCall) sb.removeChannel(chCall); } catch (e) {}
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
    try {
      if (call && !done) {
        var patch = live ? { state: 'ended' } : { state: isCaller ? 'cancelled' : 'declined' };
        sb.from('calls').update(patch).eq('id', call.id).then(function () {}, function () {});
      }
    } catch (e) {}
    finish(live ? 'ended' : (isCaller ? 'ended' : 'declined'));
  }

  /* ================= WebRTC ================= */

  function signal(kind, data) {
    if (!room || !me) return;
    var payload = { kind: kind };
    if (data) for (var k in data) payload[k] = data[k];
    sb.from('room_events').insert({
      room_code: room, kind: 'signal', sender_id: me.id, payload: payload
    }).then(function () {}, function () {});
  }

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

  function buildPeer(st) {
    pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 4 });
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
      pc.onnegotiationneeded = function () {
        pc.createOffer().then(function (o) {
          return pc.setLocalDescription(o);
        }).then(function () {
          offerSentAt = Date.now();
          signal('offer', { sdp: pc.localDescription.sdp });
        }).catch(function () {});
      };
    }
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

  /* ================= подписка на комнату ================= */

  function subscribeRoom() {
    chRoom = sb.channel('ksu-call-' + room)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_events', filter: 'room_code=eq.' + room },
        function (p) {
          var row = p.new;
          if (!row || row.sender_id === me.id) return;
          var pl = row.payload || {};
          if (row.kind !== 'signal') return;
          if (pl.kind === 'offer') onOffer(pl);
          else if (pl.kind === 'answer') onAnswer(pl);
          else if (pl.kind === 'ice') onIce(pl);
          else if (pl.kind === 'bye') finish('peer_left');
        })
      .subscribe();
  }

  function subscribeCall() {
    chCall = sb.channel('ksu-callrow-' + callId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: 'id=eq.' + callId },
        function (p) {
          var row = p.new;
          if (!row) return;
          if (row.state === 'ended' || row.state === 'cancelled' || row.state === 'missed'
              || row.state === 'declined') {
            finish(row.state === 'missed' ? 'missed' : (row.state === 'declined' ? 'declined' : 'ended'));
          }
        })
      .subscribe();
  }

  /* ================= принятие ================= */

  function accept() {
    show('btn-accept', false);
    show('btn-decline', true);
    setNote('');
    setPhase(T('connecting'));
    sb.from('calls').update({ state: 'answered' }).eq('id', callId).then(function () {}, function () {});
    startMedia();
  }

  function startMedia() {
    media().then(function (st) {
      buildPeer(st);
      subscribeRoom();
      if (!isCaller) {
        // Гость отвечает — свою сторону SDP отдаст по offer'у от звонящего.
      }
    }).catch(function () {
      setPhase(lang === 'ru' ? 'Нет доступа к камере/микрофону' : 'No camera/microphone access');
    });
  }

  /* ================= старт ================= */

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
    subscribeCall();

    if (isCaller) {
      show('btn-accept', false);
      show('btn-decline', true);
      setNote(T('calling_hint'));
      setPhase(T('calling'));
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
    if (call && !live) {
      sb.from('calls').update({ state: isCaller ? 'cancelled' : 'declined' }).eq('id', call.id)
        .then(function () {}, function () {});
    }
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

  window.addEventListener('pagehide', function () { try { if (!done) signal('bye', {}); } catch (e) {} });
})();
