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
      today: 'сегодня', yesterday: 'Вчера', write: 'Написать', added_short: 'в контактах',
      watch: 'Смотрим вместе', call_audio: 'Аудиозвонок', call_video: 'Видеозвонок',
      incoming_audio: 'Входящий звонок', incoming_video: 'Входящий видеозвонок',
      answer: 'Ответить', decline: 'Отклонить',
      name_ph: 'Имя', pass_ph: 'Пароль',
      add_contact: 'Добавить контакт', send: 'Отправить', close: 'Закрыть', back: 'Назад',
      title: 'KsuNiMeet — звонки и сообщения'
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
      today: 'today', yesterday: 'Yesterday', write: 'Message', added_short: 'in contacts',
      watch: 'Watch together', call_audio: 'Voice call', call_video: 'Video call',
      incoming_audio: 'Incoming call', incoming_video: 'Incoming video call',
      answer: 'Answer', decline: 'Decline',
      name_ph: 'Name', pass_ph: 'Password',
      add_contact: 'Add contact', send: 'Send', close: 'Close', back: 'Back',
      title: 'KsuNiMeet — calls and messages'
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
    $('auth-user').placeholder = T('name_ph');
    $('auth-pass').placeholder = T('pass_ph');
    $('search-input').placeholder = T('search_ph');
    $('chat-input').placeholder = T('msg_ph');
    var pills = document.querySelectorAll('.js-lang');
    for (var j = 0; j < pills.length; j++) pills[j].textContent = lang === 'ru' ? 'EN' : 'RU';
    // Подписи для экранного диктора тоже переводятся: иначе в английском
    // интерфейсе кнопки вслух назывались бы по-русски.
    var ars = document.querySelectorAll('[data-i18n-aria]');
    for (var a = 0; a < ars.length; a++) {
      var ak = ars[a].getAttribute('data-i18n-aria');
      ars[a].setAttribute('aria-label', T(ak));
      if (ars[a].hasAttribute('title')) ars[a].setAttribute('title', T(ak));
    }
    try { document.documentElement.lang = lang; } catch (e) {}
    document.title = T('title');
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
    lastIncomingId: 0,     // id самого свежего входящего — для контрольного опроса
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
    realtime: { params: { eventsPerSecond: 20 } },
    /* Запросы идут через net.js: у каждого есть дедлайн и повтор. На канале,
     * который рвётся после ~16 КБ (сеть Cloudflare в России), это разница
     * между «пришло со второго раза» и «нет связи с сервером». */
    global: { fetch: (window.KSU_NET && window.KSU_NET.fetch) || undefined }
  });

  /* Адрес для входа синтезируется из имени: почты у пользователя нет,
   * а Supabase Auth её требует. Домен example.com письма никуда не шлёт. */
  function emailFor(name) { return String(name).toLowerCase() + '@ksunimeet.example.com'; }
  function chatKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* ================= мост с Android =================
   *
   * В APK страница живёт внутри WebView, и нативные уведомления нужно
   * включать и снабжать токеном от самой страницы. В обычном браузере
   * window.KsuNiMeet нет — тогда все вызовы молча ничего не делают. */
  function bridge(name, a, b, c) {
    try {
      var br = window.KsuNiMeet;
      if (br && typeof br[name] === 'function') br[name](a, b, c);
    } catch (e) {}
  }

  /* Токен сессии кладём в нативную память: фоновый опрос читает новые
   * сообщения от имени пользователя. access_token живёт около часа, поэтому
   * отдаём ещё и refresh_token — сервис сам продлит доступ, пока приложение
   * свёрнуто и страница не может этого сделать. */
  function pushSession(session) {
    if (!session || !session.access_token || !session.user) return;
    bridge('saveSession', session.access_token, session.user.id, session.refresh_token || '');
  }

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
      loadChats().then(openDeepLink);
      subscribe();
      wireExtras();
      pushSession(session);
      bridge('enable');        // фоновые уведомления (нативный опрос Supabase)
      bridge('setAppActive', true);
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
      checkPendingCall();
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
        // Запоминаем самый свежий входящий: опрос сравнивает с ним и молчит,
        // пока ничего нового не пришло.
        var maxIn = 0;
        (r.data || []).forEach(function (m) {
          if (m.recipient_id === me && Number(m.id) > maxIn) maxIn = Number(m.id);
        });
        if (maxIn > state.lastIncomingId) state.lastIncomingId = maxIn;
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

  /* APK открывает страницу с ?peer=<id>, когда человек нажал уведомление о
   * сообщении. Открываем нужный чат, как только подгрузились чаты, и убираем
   * параметр из адреса, чтобы он не сработал снова. */
  function openDeepLink() {
    var id = null;
    try { id = new URLSearchParams(location.search).get('peer'); } catch (e) {}
    if (!id || !state.user) return;
    if (state.chatOpen && state.peer && state.peer.id === id) return;
    openChat(peerOf(id));
    try { history.replaceState(history.state, '', location.pathname + location.hash); } catch (e) {}
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
        ping(peerId, 'msg');   // будим собеседника: пусть сходит и перечитает
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

  /* ================= realtime =================
   *
   * ПОЧЕМУ НЕ postgres_changes: на этом проекте постгресовые подписки не
   * доставляют ничего для таблиц с включённым RLS. Проверено трижды — и для
   * anon, и для service_role, и с открытой политикой using(true): при RLS off
   * события приходят, при RLS on исчезают молча (сокет подписывается, и тишина).
   * Поэтому «живость» держится на broadcast, который через проверку строк не
   * проходит вообще и работает исправно.
   *
   * ПИНГ — ЭТО БУДИЛЬНИК, А НЕ ДАННЫЕ. Он ничего не сообщает по существу:
   * ни текста, ни имён, ни номера. Он говорит ровно одно — «сходи перечитай».
   * Всё настоящее приходит из REST, где RLS решает, что мне видно. Поэтому
   * подделанный (или чужой) пинг не может показать чужие сообщения и не может
   * поднять фальшивый звонок: пока в `calls` нет реальной строки со мной в
   * роли принимающего, экран входящего не появится.
   *
   * Основной путь — пинг; раз в 5 с есть и контрольный пересмотр (limit 1),
   * чтобы ничего не потерялось, если вкладка спала или пинг ушёл в пустоту.
   */

  var channel = null;
  var peerChans = {};   // peerId -> { ch: канал собеседника, joined, queue }

  function userChannel(uid) { return 'ksu-user-' + uid; }

  function fire(ch, payload) {
    try { ch.send({ type: 'broadcast', event: 'ping', payload: payload }); } catch (e) {}
  }

  /* Собеседник слушает СВОЙ канал, поэтому, чтобы ему постучать, нужно быть
   * подписанным на его канал. Подписка делается один раз на человека и
   * живёт до выхода; пинги, отправленные до подписки, копятся в очереди. */
  function ping(peerId, kind) {
    if (!state.user || !peerId || peerId === state.user.id) return;
    var payload = { to: peerId, from: state.user.id, kind: kind || 'msg', at: Date.now() };
    var rec = peerChans[peerId];
    if (!rec) {
      rec = peerChans[peerId] = { ch: null, joined: false, queue: [] };
      rec.ch = sb.channel(userChannel(peerId)).subscribe(function (s) {
        if (s === 'SUBSCRIBED') {
          rec.joined = true;
          var q2 = rec.queue; rec.queue = [];
          q2.forEach(function (p) { fire(rec.ch, p); });
        } else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          rec.joined = false;
        }
      });
    }
    if (rec.joined) fire(rec.ch, payload);
    else {
      rec.queue.push(payload);
      if (rec.queue.length > 20) rec.queue.shift();
    }
  }

  function subscribe() {
    if (!state.user) return;
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} channel = null; }
    channel = sb.channel(userChannel(state.user.id))
      .on('broadcast', { event: 'ping' }, function (p) {
        var pl = p && p.payload;
        if (!pl || !state.user || pl.to !== state.user.id) return;
        onPing(pl);
      })
      .subscribe();
  }

  function onPing(pl) {
    if (!state.user) return;
    if (pl.kind === 'call') { checkPendingCall(); return; }
    if (state.chatOpen && state.peer && (!pl.from || state.peer.id === pl.from)) {
      loadNewMessages(state.peer.id);
      markRead(state.peer.id);
    } else {
      loadChats();
    }
  }

  /* Дочитать только то, чего ещё нет в ленте. Полная перезагрузка переписки
   * на каждое входящее сдвигала бы прокрутку и мигала. */
  function loadNewMessages(peerId) {
    if (!state.user) return Promise.resolve();
    var maxId = 0;
    state.msgs.forEach(function (m) {
      var n = Number(m.id);
      if (isFinite(n) && n > maxId) maxId = n;
    });
    var query = sb.from('messages')
      .select('id,sender_id,recipient_id,body,created_at,read_at')
      .eq('chat_key', chatKey(state.user.id, peerId))
      .order('id', { ascending: true })
      .limit(60);
    if (maxId) query = query.gt('id', maxId);
    return query.then(function (r) {
      if (r.error) return;
      var added = 0;
      (r.data || []).forEach(function (m) {
        if (state.seen[m.id]) return;
        appendOne(m);
        upsertChat(peerId, m, m.sender_id === state.user.id);
        added++;
      });
      if (added) scrollBottom(false);
    });
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
    Object.keys(peerChans).forEach(function (k) {
      try { sb.removeChannel(peerChans[k].ch); } catch (e) {}
    });
    peerChans = {};
    bridge('disable');   // вышли — фоновый опрос больше не нужен
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

  /* ================= звонки и «Смотрим вместе» =================
   *
   * Исходящий звонок — строка в `calls`. О входящем узнаём пингом по
   * broadcast'у (та же дорога, что и у сообщений), плюс контрольный пересмотр
   * таблицы раз в 4 с — на случай, если пинг не дошёл, пока вкладка спала.
   * Решение (ответить/отклонить) пишется в ту же строку, поэтому у звонящего
   * состояние меняется мгновенно.
   */
  var callPollInt = null, syncInt = null;

  function randomCode() {
    var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  function startCall(peer, withVideo) {
    if (!peer || !state.user) return;
    var room = randomCode();
    sb.from('calls').insert({
      caller_id: state.user.id, callee_id: peer.id, state: 'ringing',
      video: !!withVideo, room_code: room
    }).select('id').then(function (r) {
      if (r.error || !r.data || !r.data[0]) { toast(r.error ? r.error.message : T('err_net')); return; }
      // Строка уже есть — стучим получателю, и только потом уходим на экран
      // звонка: уходя сразу, мы бы оборвали отправку пинга на полуслове.
      ping(peer.id, 'call');
      var url = 'call.html?call=' + encodeURIComponent(r.data[0].id) + '&out=1&video=' + (withVideo ? 1 : 0);
      setTimeout(function () { location.href = url; }, 250);
    });
  }

  function openWatch() { location.href = 'watch.html'; }

  $('call-audio').addEventListener('click', function () { startCall(state.peer, false); });
  $('call-video').addEventListener('click', function () { startCall(state.peer, true); });
  $('watch-btn').addEventListener('click', openWatch);
  $('watch-btn-2').addEventListener('click', openWatch);

  /* ---- входящий звонок ---- */

  var ringCall = null, ringTimer = null;

  function showIncoming(c) {
    ringCall = c;
    sb.from('profiles').select('id,username,phone').eq('id', c.caller_id).maybeSingle().then(function (r) {
      var p = r.data || { username: '?', phone: '' };
      $('inc-avatar').textContent = (p.username || '?').charAt(0).toUpperCase();
      $('inc-name').textContent = p.username || '?';
      $('inc-phone').textContent = p.phone ? fmtPhone(p.phone) : '';
      $('inc-kind').textContent = c.video ? T('incoming_video') : T('incoming_audio');
    });
    $('incoming').classList.remove('hidden');
    // Нативный экран/мелодия в APK: система сама покажет «звонок», как WhatsApp.
    try { if (window.KsuNiMeet && window.KsuNiMeet.inCall) window.KsuNiMeet.inCall(true); } catch (e) {}
    try { document.title = T('incoming_audio') + ' · KsuNiMeet'; } catch (e) {}
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = setInterval(function () { if (!ringCall) { clearInterval(ringTimer); ringTimer = null; return; } beep(); }, 1600);
    beep();
  }

  function hideIncoming() {
    ringCall = null;
    $('incoming').classList.add('hidden');
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    try { document.title = T('title'); } catch (e) {}
    try { if (window.KsuNiMeet && window.KsuNiMeet.inCall) window.KsuNiMeet.inCall(false); } catch (e) {}
  }

  /* Короткий тон через WebAudio: страница не может положиться на <audio>
   * до первого касания, а генератор работает всегда. */
  var ringCtx = null;
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ringCtx) ringCtx = new AC();
      if (ringCtx.state === 'suspended') ringCtx.resume().catch(function () {});
      var o = ringCtx.createOscillator(), g = ringCtx.createGain();
      o.type = 'sine'; o.frequency.value = 620;
      g.gain.value = 0.0001;
      o.connect(g); g.connect(ringCtx.destination);
      var t0 = ringCtx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
      o.start(t0); o.stop(t0 + 0.75);
    } catch (e) {}
  }

  $('inc-accept').addEventListener('click', function () {
    if (!ringCall) return;
    // Снимаем ВСЁ, что нужно, ДО hideIncoming(): он обнуляет ringCall, и
    // обращение к ringCall.video после него — это TypeError, из-за которого
    // «ответить» вообще не срабатывало (звонок так и оставался ringing).
    var id = ringCall.id, caller = ringCall.caller_id, withVideo = !!ringCall.video;
    hideIncoming();
    ping(caller, 'call');   // звонящий сразу видит, что трубку подняли
    // accepted=1 — чтобы на экране звонка не спрашивали «ответить?» второй раз.
    var url = 'call.html?call=' + encodeURIComponent(id) + '&video=' + (withVideo ? 1 : 0) + '&accepted=1';
    // Уходим на экран звонка ТОЛЬКО после того, как запись состояния дошла.
    // Раньше переход стоял следующей строкой и обрывал летящий PATCH: звонок
    // так и оставался ringing, а база через 27 с объявляла его пропущенным.
    var jumped = false;
    var go = function () { if (jumped) return; jumped = true; location.href = url; };
    sb.from('calls').update({ state: 'answered' }).eq('id', id).then(go, go);
    setTimeout(go, 400);
  });

  $('inc-decline').addEventListener('click', function () {
    if (!ringCall) return;
    var id = ringCall.id, caller = ringCall.caller_id;
    hideIncoming();
    sb.from('calls').update({ state: 'declined' }).eq('id', id).then(function () {}, function () {});
    ping(caller, 'call');
  });

  /* Входящий звонок: пинг приходит мгновенно, а этот сторож ещё и сверяется
   * с таблицей — он же гасит экран, если звонок отменили или он истёк. */
  function subscribeCalls() {
    if (!state.user) return;
    checkPendingCall();
    if (callPollInt) clearInterval(callPollInt);
    callPollInt = setInterval(checkPendingCall, 4000);
  }

  /* Звонок мог начаться, пока мы были на другой вкладке. Смотрим не только
   * «есть ли свежий вызов», но и не пропала ли труба у того, что уже показываем. */
  function checkPendingCall() {
    if (!state.user) return;
    sb.from('calls').select('id,caller_id,video,state,created_at')
      .eq('callee_id', state.user.id).eq('state', 'ringing')
      .order('created_at', { ascending: false }).limit(1).then(function (r) {
        var c = r.data && r.data[0];
        if (!c) { if (ringCall) hideIncoming(); return; }
        if (Date.now() - new Date(c.created_at).getTime() > 27000) {  // уже истёк
          if (ringCall && ringCall.id === c.id) hideIncoming();
          return;
        }
        if (!ringCall) showIncoming(c);
      });
  }

  /* Контрольный опрос сообщений: один лёгкий запрос (limit 1) раз в 5 с.
   * Если id самого свежего входящего не изменился — дальше не идём, ничего
   * не перечитываем. Это страховка на случай спящей вкладки, а не основной путь. */
  function pollIncoming() {
    if (!state.user || document.visibilityState !== 'visible') return;
    sb.from('messages').select('id').eq('recipient_id', state.user.id)
      .order('id', { ascending: false }).limit(1).then(function (r) {
        var id = r.data && r.data[0] && Number(r.data[0].id);
        if (!id || id === state.lastIncomingId) return;
        state.lastIncomingId = id;
        if (state.chatOpen && state.peer) { loadNewMessages(state.peer.id); markRead(state.peer.id); }
        else loadChats();
      });
  }

  var watchBtnDone = false;
  function wireExtras() {
    if (watchBtnDone) return;
    watchBtnDone = true;
    subscribeCalls();
    if (syncInt) clearInterval(syncInt);
    syncInt = setInterval(pollIncoming, 5000);
  }

  /* ================= старт ================= */

  applyLang();
  setMode('login');
  wireVisibility();

  /* Уже входили раньше? Тогда приложение открывается сразу — без экрана входа.
   *
   * Дедлайн здесь обязателен: без сети `getSession()` не отвечает НИКОГДА,
   * и человек видит пустую страницу. Через 9 с показываем экран входа и
   * полоску «нет связи — повторить». Пустая страница не объясняет ничего. */
  function bootSession() {
    var req = sb.auth.getSession();
    if (!window.KSU_NET) {
      req.then(function (r) {
        var s = r && r.data && r.data.session;
        if (!s) { showAuth(); return; }
        onSignedIn(s).catch(showAuth);
      }, showAuth);
      return;
    }
    KSU_NET.deadline(req, 9000).then(function (out) {
      if (out.timedOut) { KSU_NET.retry(); showAuth(); return; }
      if (!out.ok) { showAuth(); return; }
      var r = out.value;
      var session = r && r.data && r.data.session;
      if (!session) { showAuth(); return; }
      onSignedIn(session).catch(showAuth);
    });
  }

  bootSession();
  // Кнопка «Повторить» в полоске: связи нет — пробуем ещё раз.
  window.addEventListener('ksu-net-retry', function () {
    if (!state.user) bootSession();
    else if (state.peer) loadNewMessages(state.peer.id);
    else loadChats();
  });

  sb.auth.onAuthStateChange(function (evt, session) {
    if (evt === 'SIGNED_OUT') { bridge('disable'); showAuth(); }
    // Токен продлили — сразу отдаём свежий нативному опросу.
    else if (evt === 'TOKEN_REFRESHED' && session) pushSession(session);
    else if (evt === 'SIGNED_IN' && session && !state.user) onSignedIn(session).catch(function () {});
  });
})();
