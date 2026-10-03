/* KsuNiMeet — приложение (GitHub Pages + Supabase).
 *
 * Что здесь: вход по имени и паролю, контакты, переписка 1-на-1 и живая
 * доставка сообщений. Прежняя PHP-версия опрашивала сервер каждые 1,2 с
 * (два запроса на тик); здесь подписка Realtime — сервер сам присылает
 * строку, поэтому задержка падает с «до 1,2 с» до «как дошло».
 *
 * Три вещи, которые делают интерфейс «масляным», а не просто рабочим:
 *   1. Отправка НЕ ждёт сервера: сообщение появляется в ленте сразу
 *      (оптимистично), а потом подменяется настоящей строкой.
 *   2. Ответ на отправку берём вместе со строкой (insert ... select),
 *      поэтому не нужен второй запрос «а что я только что отправил».
 *   3. Всё состояние — в памяти: перерисовка это innerHTML одного
 *      контейнера, без фреймворка и без виртуального DOM.
 */
(function () {
  'use strict';

  var CFG = window.KSU_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  /* ================= i18n ================= */

  var I18N = {
    ru: {
      tag_micro: 'Бесплатные сообщения для двоих',
      tagline: 'Свой номер, контакты и переписка.<br>Сообщения приходят мгновенно.',
      signin: 'Вход', signup: 'Регистрация', signin_btn: 'Войти', create: 'Создать аккаунт',
      hint_login: 'Войдите, чтобы писать по контактам.',
      hint_signup: 'Имя и пароль — без почты и телефона. Номер выдаётся сразу.',
      foot: 'Работает в России · обычный сайт без туннелей и прокси',
      chats: 'Чаты', contacts: 'Контакты', profile: 'Профиль',
      micro_messages: 'Сообщения', micro_people: 'Мои люди', micro_account: 'Аккаунт',
      chats_empty: 'Сообщений пока нет.<br>Нажмите ✎ и напишите первому.',
      contacts_empty: 'Контактов пока нет.<br>Нажмите «+» и найдите человека по имени или номеру.',
      new_contact: 'Новый контакт', new_message: 'Новое сообщение',
      copy_num: 'Скопировать номер',
      profile_note: 'Это ваш номер в KsuNiMeet. Сообщите его — и вам смогут писать.',
      signout: 'Выйти',
      search_ph: 'Имя или номер (8 цифр)', msg_ph: 'Сообщение',
      err_creds: 'Неверное имя или пароль.', err_taken: 'Это имя уже занято.',
      err_name: 'Имя: 3–20 символов — латиница, цифры и «_».',
      err_pass: 'Пароль — минимум 6 символов.', err_net: 'Нет связи с сервером.',
      err_need: 'Введите имя и пароль.',
      search_hint: 'Введите имя или 8-значный номер.',
      not_found: 'Никого не найдено.', added: 'Добавлено в контакты',
      you: 'Вы: ', failed: 'Не отправлено · нажмите, чтобы повторить',
      last_none: 'Сообщений пока нет', copy_ok: 'Номер скопирован',
      today: 'сегодня', yesterday: 'Вчера', write: 'Написать', added_short: 'в контактах'
    },
    en: {
      tag_micro: 'Free messaging for two',
      tagline: 'Your own number, contacts and chats.<br>Messages arrive instantly.',
      signin: 'Sign in', signup: 'Sign up', signin_btn: 'Sign in', create: 'Create account',
      hint_login: 'Sign in to message your contacts.',
      hint_signup: 'Just a name and a password — no email or phone. You get your number at once.',
      foot: 'Works in Russia · an ordinary website, no tunnels or proxies',
      chats: 'Chats', contacts: 'Contacts', profile: 'Profile',
      micro_messages: 'Messages', micro_people: 'My people', micro_account: 'Account',
      chats_empty: 'No messages yet.<br>Tap ✎ and write to someone first.',
      contacts_empty: 'No contacts yet.<br>Tap “+” and find someone by name or number.',
      new_contact: 'New contact', new_message: 'New message',
      copy_num: 'Copy number',
      profile_note: 'This is your KsuNiMeet number. Share it so people can write to you.',
      signout: 'Sign out',
      search_ph: 'Name or number (8 digits)', msg_ph: 'Message',
      err_creds: 'Wrong name or password.', err_taken: 'That name is taken.',
      err_name: 'Name: 3–20 characters — letters, digits and “_”.',
      err_pass: 'Password must be at least 6 characters.', err_net: 'No connection to the server.',
      err_need: 'Enter a name and a password.',
      search_hint: 'Type a name or an 8-digit number.',
      not_found: 'Nobody found.', added: 'Added to contacts',
      you: 'You: ', failed: 'Not sent · tap to retry',
      last_none: 'No messages yet', copy_ok: 'Number copied',
      today: 'today', yesterday: 'Yesterday', write: 'Message', added_short: 'in contacts'
    }
  };

  var LANG_KEY = 'ksu_lang';
  var lang = (function () {
    try {
      var s = localStorage.getItem(LANG_KEY);
      if (s === 'ru' || s === 'en') return s;
    } catch (e) {}
    var l = (navigator.language || '').toLowerCase();
    if (!l) return 'ru';
    if (/^(ru|be|uk|kk)/.test(l)) return 'ru';
    return 'en';
  })();
  function T(k) { return (I18N[lang] && I18N[lang][k]) || I18N.ru[k] || k; }

  function applyLang() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-i18n');
      if (k === 'tagline' || k === 'chats_empty' || k === 'contacts_empty') {
        nodes[i].innerHTML = T(k);
      } else {
        nodes[i].textContent = T(k);
      }
    }
    $('auth-user').placeholder = lang === 'ru' ? 'Имя' : 'Name';
    $('auth-pass').placeholder = lang === 'ru' ? 'Пароль' : 'Password';
    $('search-input').placeholder = T('search_ph');
    $('chat-input').placeholder = T('msg_ph');
    var pills = document.querySelectorAll('.js-lang');
    for (var j = 0; j < pills.length; j++) pills[j].textContent = lang === 'ru' ? 'EN' : 'RU';
    if (state.user) { renderMe(); renderChats(); renderContacts(); }
  }

  /* ================= helpers ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtPhone(p) {
    var s = String(p || '');
    return s.length === 8 ? s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6) : s;
  }
  function whenLabel(iso) {
    var d = new Date(iso), n = new Date();
    var same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (same) return hm;
    var y = new Date(n.getTime() - 864e5);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
      return T('yesterday');
    }
    var dd = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
    return d.getFullYear() === n.getFullYear() ? dd : dd + '.' + String(d.getFullYear()).slice(2);
  }
  function dayLabel(iso) {
    var d = new Date(iso), n = new Date();
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
      return T('today');
    }
    var y = new Date(n.getTime() - 864e5);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
      return T('yesterday');
    }
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
  }
  function sameDay(a, b) {
    if (!a || !b) return false;
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.querySelector('.toast');
    if (el) el.parentNode.removeChild(el);
    el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2200);
  }

  /* ================= состояние ================= */

  var state = {
    user: null,            // {id, username, phone}
    contacts: [],          // [{id, username, phone}]
    chats: [],             // [{peer, last, lastAt, unread, lastFromMe}]
    peer: null,            // открытый собеседник
    msgs: [],              // сообщения открытой переписки
    seen: {},              // id сообщений, которые уже в ленте
    chatOpen: false,
    tab: 'chats',
    searchMode: 'contact',
    signingIn: null,       // uid, для которого вход уже идёт (защита от двойной загрузки)
    signingInPromise: null
  };

  /* ================= Supabase ================= */

  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    $('auth-err').textContent = 'config.js не загрузился';
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    $('auth-err').textContent = lang === 'ru'
      ? 'Клиент не загрузился. Обновите страницу.'
      : 'Client failed to load. Reload the page.';
    return;
  }

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ksu-auth' },
    realtime: { params: { eventsPerSecond: 20 } }
  });

  /* Адрес для входа синтезируется из имени: почты у пользователя нет,
   * а Supabase Auth её требует. Домен example.com письма никуда не шлёт. */
  function emailFor(name) { return String(name).toLowerCase() + '@ksunimeet.example.com'; }
  function chatKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* ================= экраны ================= */

  function showAuth() {
    state.user = null;
    state.chatOpen = false;
    // Снимаем пометку входа: после выхода тот же человек должен войти заново,
    // а не получить «уже вхожу» от прошлого раза.
    state.signingIn = null;
    state.signingInPromise = null;
    $('chat-view').classList.add('hidden');
    $('screen-auth').classList.remove('hidden');
    $('screen-app').classList.add('hidden');
  }
  function showApp() {
    $('screen-auth').classList.add('hidden');
    $('screen-app').classList.remove('hidden');
    renderMe();
  }
  function setTab(name) {
    state.tab = name;
    ['chats', 'contacts', 'profile'].forEach(function (t) {
      $('tab-' + t).classList.toggle('hidden', t !== name);
      $('tabbtn-' + t).classList.toggle('tab-active', t === name);
    });
  }

  /* ================= вход ================= */

  var authMode = 'login';

  function setMode(m) {
    authMode = m;
    $('seg-login').classList.toggle('seg-active', m === 'login');
    $('seg-signup').classList.toggle('seg-active', m === 'signup');
    $('auth-submit').textContent = m === 'signup' ? T('create') : T('signin_btn');
    $('auth-hint').textContent = m === 'signup' ? T('hint_signup') : T('hint_login');
    $('auth-err').textContent = '';
  }

  function authError(e) {
    var m = String((e && (e.message || e.error_description)) || '');
    if (/invalid login credentials/i.test(m)) return T('err_creds');
    if (/already registered|already exists|duplicate/i.test(m)) return T('err_taken');
    if (/password should be at least/i.test(m)) return T('err_pass');
    if (/fetch|network|load failed|timeout/i.test(m)) return T('err_net');
    return m || T('err_net');
  }

  function doAuth() {
    var name = ($('auth-user').value || '').trim().toLowerCase();
    var pass = $('auth-pass').value || '';
    var err = $('auth-err');
    if (!name || !pass) { err.textContent = T('err_need'); return; }
    if (authMode === 'signup') {
      if (!/^[a-z0-9_]{3,20}$/.test(name)) { err.textContent = T('err_name'); return; }
      if (pass.length < 6) { err.textContent = T('err_pass'); return; }
    }
    err.textContent = '';
    var btn = $('auth-submit');
    btn.disabled = true;

    var p = authMode === 'signup'
      ? sb.auth.signUp({ email: emailFor(name), password: pass, options: { data: { username: name } } })
          .then(function (r) {
            if (r.error) throw r.error;
            // Подтверждение почты в проекте выключено, поэтому сессия приходит
            // сразу. Если её всё же нет — просто входим тем же паролем.
            if (r.data && r.data.session) return r.data.session;
            return sb.auth.signInWithPassword({ email: emailFor(name), password: pass })
              .then(function (s) { if (s.error) throw s.error; return s.data.session; });
          })
      : sb.auth.signInWithPassword({ email: emailFor(name), password: pass })
          .then(function (r) { if (r.error) throw r.error; return r.data.session; });

    p.then(function (session) {
      btn.disabled = false;
      if (!session) { err.textContent = T('err_net'); return; }
      onSignedIn(session);
    }).catch(function (e) {
      btn.disabled = false;
      err.textContent = authError(e);
    });
  }

  /* ================= профиль ================= */

  /* Вход может прийти ДВУМЯ путями сразу: из getSession() при открытии
   * страницы и из onAuthStateChange('SIGNED_IN'). Пока профиль грузится по
   * сети, state.user ещё пуст — и второй путь запускал ВТОРОЙ полный цикл
   * загрузки (профиль, контакты и 300 сообщений — по разу лишних). На
   * медленном канале это заметные полсекунды и лишний трафик.
   * Поэтому пометку ставим СИНХРОННО, до первого await, а не по state.user. */
  function onSignedIn(session) {
    var uid = session.user.id;
    if (state.user && state.user.id === uid) return Promise.resolve();
    if (state.signingIn === uid) return state.signingInPromise || Promise.resolve();
    state.signingIn = uid;
    try { sb.realtime.setAuth(session.access_token); } catch (e) {}
    state.signingInPromise = loadProfile(uid).then(function () {
      showApp();
      setTab('chats');
      loadContacts();
      loadChats();
      subscribe();
    }).catch(function (e) {
      // Не удалось — снимаем пометку, чтобы повторный вход сработал.
      state.signingIn = null;
      state.signingInPromise = null;
      throw e;
    });
    return state.signingInPromise;
  }

  /* Возврат в приложение: подписка могла отвалиться, пока вкладка спала, —
   * молча поднимаем её и перечитываем чаты. Слушатель вешается ОДИН раз: он
   * раньше добавлялся на каждом входе, и после нескольких входов один возврат
   * в приложение отправлял столько же запросов, сколько было входов. */
  var visibleWired = false;
  function wireVisibility() {
    if (visibleWired) return;
    visibleWired = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !state.user) return;
      loadChats();
      if (state.chatOpen && state.peer) loadMessages(state.peer.id, true);
    });
  }

  function loadProfile(uid) {
    return sb.from('profiles').select('id,username,phone').eq('id', uid).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        state.user = r.data || { id: uid, username: '', phone: '' };
      });
  }

  function renderMe() {
    if (!state.user) return;
    var u = state.user;
    var initial = (u.username || 'K').charAt(0).toUpperCase();
    $('app-avatar').textContent = initial;
    $('profile-avatar').textContent = initial;
    $('app-name').textContent = u.username;
    $('app-phone').textContent = fmtPhone(u.phone);
    $('profile-name').textContent = u.username;
    $('profile-phone').textContent = fmtPhone(u.phone);
  }

  /* ================= контакты ================= */

  function loadContacts() {
    return sb.from('contacts')
      .select('peer:profiles!contacts_peer_id_fkey(id,username,phone)')
      .eq('owner_id', state.user.id)
      .then(function (r) {
        if (r.error) { toast(r.error.message); return; }
        state.contacts = (r.data || []).map(function (x) { return x.peer; }).filter(Boolean);
        renderContacts();
      });
  }

  function renderContacts() {
    var box = $('contacts-list'), empty = $('contacts-empty');
    if (!state.contacts.length) {
      box.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    box.innerHTML = state.contacts.map(function (c) {
      return '<button class="row" data-uid="' + esc(c.id) + '">' +
        '<div class="avatar sm">' + esc((c.username || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div class="row-main"><div class="row-name">' + esc(c.username) + '</div>' +
        '<div class="row-sub">' + esc(fmtPhone(c.phone)) + '</div></div>' +
        '</button>';
    }).join('');
  }

  /* ================= список чатов ================= */

  function loadChats() {
    if (!state.user) return Promise.resolve();
    var me = state.user.id;
    // Один запрос: последние 300 сообщений с моим участием. Из них считается
    // и «последнее сообщение» по каждому собеседнику, и свежие непрочитанные.
    return sb.from('messages')
      .select('id,chat_key,sender_id,recipient_id,body,created_at,read_at')
      .or('sender_id.eq.' + me + ',recipient_id.eq.' + me)
      .order('id', { ascending: false })
      .limit(300)
      .then(function (r) {
        if (r.error) { toast(r.error.message); return; }
        var byPeer = {};
        (r.data || []).forEach(function (m) {
          var peerId = m.sender_id === me ? m.recipient_id : m.sender_id;
          var c = byPeer[peerId] || (byPeer[peerId] = { last: null, unread: 0 });
          if (!c.last) c.last = m;
          if (m.recipient_id === me && !m.read_at) c.unread++;
        });
        state.chats = Object.keys(byPeer).map(function (pid) {
          var c = byPeer[pid];
          var m = c.last;
          return {
            peerId: pid,
            last: m.body,
            lastAt: m.created_at,
            lastFromMe: m.sender_id === me,
            unread: c.unread
          };
        });
        renderChats();
      });
  }

  function peerOf(id) {
    for (var i = 0; i < state.contacts.length; i++) if (state.contacts[i].id === id) return state.contacts[i];
    for (var j = 0; j < state.chats.length; j++) {
      if (state.chats[j].peerId === id && state.chats[j].peer) return state.chats[j].peer;
    }
    return { id: id, username: '?', phone: '' };
  }

  function renderChats() {
    var box = $('chats-list'), empty = $('chats-empty');
    var total = 0;
    state.chats.forEach(function (c) { total += c.unread; });
    var badge = $('badge-chats');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.classList.toggle('hidden', total === 0);

    if (!state.chats.length) {
      box.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    box.innerHTML = state.chats.map(function (c) {
      var p = peerOf(c.peerId);
      var name = p.username || '?';
      var preview = (c.lastFromMe ? T('you') : '') + (c.last || T('last_none'));
      if (preview.length > 64) preview = preview.slice(0, 64) + '…';
      var unread = c.unread > 0
        ? '<span class="badge">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '';
      return '<button class="row" data-uid="' + esc(c.peerId) + '">' +
        '<div class="avatar sm">' + esc(name.charAt(0).toUpperCase()) + '</div>' +
        '<div class="row-main"><div class="row-top"><div class="row-name">' + esc(name) + '</div>' +
        '<div class="row-when">' + esc(whenLabel(c.lastAt)) + '</div></div>' +
        '<div class="row-sub' + (c.unread ? ' unread' : '') + '">' + esc(preview) + '</div></div>' +
        unread + '</button>';
    }).join('');
  }

  /* ================= переписка ================= */

  function openChat(peer) {
    state.peer = peer;
    state.chatOpen = true;
    state.msgs = [];
    state.seen = {};
    $('chat-avatar').textContent = (peer.username || '?').charAt(0).toUpperCase();
    $('chat-nav-name').textContent = peer.username;
    $('chat-nav-sub').textContent = fmtPhone(peer.phone);
    $('chat-msgs').innerHTML = '';
    $('chat-view').classList.remove('hidden');
    loadMessages(peer.id, false);
    markRead(peer.id);
    try { history.pushState({ chat: peer.id }, '', '#' + peer.username); } catch (e) {}
  }

  function closeChat() {
    state.chatOpen = false;
    state.peer = null;
    $('chat-view').classList.add('hidden');
    loadChats();
  }

  function loadMessages(peerId, quiet) {
    var key = chatKey(state.user.id, peerId);
    return sb.from('messages')
      .select('id,sender_id,recipient_id,body,created_at,read_at')
      .eq('chat_key', key)
      .order('id', { ascending: false })
      .limit(120)
      .then(function (r) {
        if (r.error) { if (!quiet) toast(r.error.message); return; }
        var rows = (r.data || []).slice().reverse();
        state.msgs = rows;
        state.seen = {};
        rows.forEach(function (m) { state.seen[m.id] = 1; });
        renderMessages();
        if (!quiet) scrollBottom(true);
      });
  }

  function renderMessages() {
    var box = $('chat-msgs');
    var html = '';
    var prev = null;
    state.msgs.forEach(function (m) {
      if (!prev || !sameDay(prev, m.created_at)) {
        html += '<div class="msg-when">' + esc(dayLabel(m.created_at)) + '</div>';
      }
      prev = m.created_at;
      var mine = m.sender_id === state.user.id;
      var cls = 'msg' + (mine ? ' me' : '') + (m._pending ? ' pending' : '') + (m._fail ? ' fail' : '');
      html += '<div class="' + cls + '" data-id="' + esc(m.id) + '">' + esc(m.body) + '</div>';
    });
    box.innerHTML = html;
  }

  function scrollBottom(force) {
    var box = $('chat-msgs');
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (force || near) box.scrollTop = box.scrollHeight;
  }

  function appendOne(m) {
    state.msgs.push(m);
    state.seen[m.id] = 1;
    var box = $('chat-msgs');
    var lastDay = null;
    if (state.msgs.length > 1) lastDay = state.msgs[state.msgs.length - 2].created_at;
    var html = '';
    if (!sameDay(lastDay, m.created_at)) {
      html += '<div class="msg-when">' + esc(dayLabel(m.created_at)) + '</div>';
    }
    var mine = m.sender_id === state.user.id;
    html += '<div class="msg' + (mine ? ' me' : '') + '" data-id="' + esc(m.id) + '">' + esc(m.body) + '</div>';
    box.insertAdjacentHTML('beforeend', html);
    scrollBottom(false);
  }

  function markRead(peerId) {
    sb.from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', state.user.id)
      .eq('sender_id', peerId)
      .is('read_at', null)
      .then(function () {
        var c = state.chats.filter(function (x) { return x.peerId === peerId; })[0];
        if (c) { c.unread = 0; renderChats(); }
      });
  }

  function send() {
    var input = $('chat-input');
    var text = (input.value || '').trim();
    if (!text || !state.peer) return;
    input.value = '';
    input.focus();

    var temp = {
      id: 'tmp' + Date.now(),
      sender_id: state.user.id,
      recipient_id: state.peer.id,
      body: text,
      created_at: new Date().toISOString(),
      _pending: true
    };
    appendOne(temp);
    scrollBottom(true);

    var peerId = state.peer.id;
    sb.from('messages')
      .insert({ sender_id: state.user.id, recipient_id: peerId, body: text })
      .select('id,sender_id,recipient_id,body,created_at,read_at')
      .single()
      .then(function (r) {
        if (r.error) throw r.error;
        settle(temp.id, r.data);
      })
      .catch(function () {
        fail(temp.id);
      });
  }

  function settle(tempId, real) {
    for (var i = 0; i < state.msgs.length; i++) {
      if (state.msgs[i].id === tempId) {
        state.msgs[i] = real;
        break;
      }
    }
    delete state.seen[tempId];
    state.seen[real.id] = 1;
    var el = document.querySelector('#chat-msgs [data-id="' + tempId + '"]');
    if (el) {
      el.setAttribute('data-id', real.id);
      el.classList.remove('pending');
    }
    var peerId = state.peer ? state.peer.id : real.recipient_id;
    upsertChat(peerId, real, true);
  }

  function fail(tempId) {
    for (var i = 0; i < state.msgs.length; i++) {
      if (state.msgs[i].id === tempId) { state.msgs[i]._fail = true; break; }
    }
    var el = document.querySelector('#chat-msgs [data-id="' + tempId + '"]');
    if (el) {
      el.classList.remove('pending');
      el.classList.add('fail');
      el.title = T('failed');
    }
  }

  function upsertChat(peerId, m, fromMe) {
    var found = null;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].peerId === peerId) { found = state.chats[i]; break; }
    }
    var atTop = !found;
    if (!found) {
      found = { peerId: peerId, unread: 0 };
      state.chats.unshift(found);
    }
    found.last = m.body;
    found.lastAt = m.created_at;
    found.lastFromMe = !!fromMe;
    if (!fromMe && !(state.chatOpen && state.peer && state.peer.id === peerId)) found.unread++;
    if (atTop && !peerOf(peerId).username) {
      // Собеседника ещё нет в контактах — подтягиваем имя, чтобы строка не была «?».
      sb.from('profiles').select('id,username,phone').eq('id', peerId).maybeSingle()
        .then(function (r) { if (r.data) { found.peer = r.data; renderChats(); } });
    }
    renderChats();
  }

  /* ================= realtime ================= */

  var channel = null;
  function subscribe() {
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} }
    channel = sb.channel('ksu-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, onRow)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, onRow)
      .subscribe();
  }

  function onRow(payload) {
    var m = payload.new;
    if (!m || !state.user) return;
    var me = state.user.id;
    if (m.sender_id !== me && m.recipient_id !== me) return; // чужие строки сюда не попадут (RLS)

    var peerId = m.sender_id === me ? m.recipient_id : m.sender_id;
    var open = state.chatOpen && state.peer && state.peer.id === peerId;

    if (payload.eventType === 'UPDATE') {
      for (var i = 0; i < state.msgs.length; i++) {
        if (state.msgs[i].id === m.id) { state.msgs[i] = m; break; }
      }
      return;
    }
    if (state.seen[m.id]) { upsertChat(peerId, m, m.sender_id === me); return; }

    if (open) {
      appendOne(m);
      markRead(peerId);
    }
    upsertChat(peerId, m, m.sender_id === me);
    if (m.sender_id !== me && !open) toast(peerOf(peerId).username + ': ' + m.body.slice(0, 60));
  }

  /* ================= поиск ================= */

  var searchTimer = null;
  function openSearch(mode) {
    state.searchMode = mode;
    $('search-title').textContent = mode === 'message' ? T('new_message') : T('new_contact');
    $('search-input').value = '';
    $('search-results').innerHTML = '';
    $('search-msg').textContent = T('search_hint');
    $('search-sheet').classList.remove('hidden');
    setTimeout(function () { $('search-input').focus(); }, 60);
  }
  function closeSearch() { $('search-sheet').classList.add('hidden'); }

  function doSearch() {
    var q = ($('search-input').value || '').trim();
    var msg = $('search-msg');
    if (q.length < 2) { $('search-results').innerHTML = ''; msg.textContent = T('search_hint'); return; }
    // Запятые и скобки сломали бы синтаксис фильтра PostgREST — вырезаем.
    // Звёздочка в PostgREST — это «%» в SQL LIKE, поэтому шаблон собираем из неё.
    var safe = q.replace(/[,()*]/g, '').trim();
    if (!safe) { $('search-results').innerHTML = ''; msg.textContent = T('search_hint'); return; }
    var digits = /^\d{2,8}$/.test(safe);
    var filter = digits ? 'phone.eq.' + safe : 'username.ilike.*' + safe + '*';
    sb.from('profiles')
      .select('id,username,phone')
      .or(filter)
      .neq('id', state.user.id)
      .limit(20)
      .then(function (r) {
        if (r.error) { msg.textContent = r.error.message; return; }
        var rows = r.data || [];
        if (!rows.length) { $('search-results').innerHTML = ''; msg.textContent = T('not_found'); return; }
        msg.textContent = '';
        var have = {};
        state.contacts.forEach(function (c) { have[c.id] = 1; });
        $('search-results').innerHTML = rows.map(function (p) {
          return '<button class="row" data-uid="' + esc(p.id) + '">' +
            '<div class="avatar sm">' + esc((p.username || '?').charAt(0).toUpperCase()) + '</div>' +
            '<div class="row-main"><div class="row-name">' + esc(p.username) + '</div>' +
            '<div class="row-sub">' + esc(fmtPhone(p.phone)) +
            (have[p.id] ? ' · ' + esc(T('added_short')) : '') + '</div></div></button>';
        }).join('');
      });
  }

  function pickPerson(p) {
    closeSearch();
    if (!state.contacts.some(function (c) { return c.id === p.id; })) {
      state.contacts.push(p);
      renderContacts();
      sb.from('contacts').insert({ owner_id: state.user.id, peer_id: p.id })
        .then(function (r) { if (r.error && !/duplicate/i.test(r.error.message)) toast(r.error.message); });
    }
    openChat(p);
  }

  /* ================= события ================= */

  $('seg-login').addEventListener('click', function () { setMode('login'); });
  $('seg-signup').addEventListener('click', function () { setMode('signup'); });
  $('auth-submit').addEventListener('click', doAuth);
  $('auth-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });

  $('tabbtn-chats').addEventListener('click', function () { setTab('chats'); });
  $('tabbtn-contacts').addEventListener('click', function () { setTab('contacts'); });
  $('tabbtn-profile').addEventListener('click', function () { setTab('profile'); });

  $('new-chat-btn').addEventListener('click', function () { openSearch('message'); });
  $('add-contact-btn').addEventListener('click', function () { openSearch('contact'); });
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 180);
  });

  $('search-results').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.row') : null;
    if (!btn) return;
    var uid = btn.getAttribute('data-uid');
    sb.from('profiles').select('id,username,phone').eq('id', uid).maybeSingle()
      .then(function (r) { if (r.data) pickPerson(r.data); });
  });

  $('contacts-list').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.row') : null;
    if (btn) openChat(peerOf(btn.getAttribute('data-uid')));
  });
  $('chats-list').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.row') : null;
    if (btn) openChat(peerOf(btn.getAttribute('data-uid')));
  });

  $('chat-back').addEventListener('click', function () {
    closeChat();
    try { if (location.hash) history.back(); } catch (e) {}
  });
  $('chat-send').addEventListener('click', send);
  $('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $('chat-msgs').addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.msg.fail') : null;
    if (!el) return;
    var id = el.getAttribute('data-id');
    var m = null;
    for (var i = 0; i < state.msgs.length; i++) if (state.msgs[i].id === id) m = state.msgs[i];
    if (!m) return;
    var text = m.body;
    el.parentNode.removeChild(el);
    state.msgs = state.msgs.filter(function (x) { return x.id !== id; });
    delete state.seen[id];
    $('chat-input').value = text;
    send();
  });

  $('profile-copy').addEventListener('click', function () {
    var num = fmtPhone(state.user ? state.user.phone : '');
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(num);
      else {
        var t = document.createElement('textarea');
        t.value = num; document.body.appendChild(t); t.select();
        document.execCommand('copy'); document.body.removeChild(t);
      }
      toast(T('copy_ok'));
    } catch (e) {}
  });

  function signOut() {
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} channel = null; }
    sb.auth.signOut().then(showAuth, showAuth);
  }
  $('logout-btn').addEventListener('click', signOut);
  $('logout-btn-2').addEventListener('click', signOut);

  document.querySelectorAll('.js-lang').forEach(function (b) {
    b.addEventListener('click', function () {
      lang = lang === 'ru' ? 'en' : 'ru';
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      applyLang();
    });
  });

  window.addEventListener('popstate', function () {
    if (state.chatOpen) closeChat();
  });

  /* ================= старт ================= */

  applyLang();
  setMode('login');
  wireVisibility();

  // Уже входили раньше? Тогда приложение открывается сразу — без экрана входа.
  sb.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (!session) { showAuth(); return; }
    onSignedIn(session).catch(showAuth);
  });

  sb.auth.onAuthStateChange(function (evt, session) {
    if (evt === 'SIGNED_OUT') showAuth();
    else if (evt === 'SIGNED_IN' && session && !state.user) onSignedIn(session).catch(function () {});
  });
})();
