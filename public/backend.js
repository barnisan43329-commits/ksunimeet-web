/* KsuNiMeet — какой клиент подключать.
 *
 * Один и тот же сайт может работать и с Supabase, и с PocketBase: разница
 * только в том, какой файл подставить вместо window.supabase. Приложение
 * (app.js, watch.js, call.js) об этом не знает — оно всегда обращается к
 * window.supabase.createClient.
 *
 * ПОЧЕМУ document.write, А НЕ ДИНАМИЧЕСКИЙ <script>.
 * Нужна синхронная вставка: app.js подключён с defer и запустится после
 * разбора страницы, но watch.js и call.js — обычные скрипты и выполняются
 * СРАЗУ. Если подставить клиент асинхронно, они успели бы обратиться к sb
 * раньше, чем он появится, и упали бы с «sb is not defined». document.write во
 * время разбора вставляет тег ровно на своё место — до обоих файлов.
 *
 * ВАЖНО: этот скрипт нельзя подключать с defer — отложенный document.write
 * выполнился бы уже после разбора и стёр бы страницу целиком.
 */
(function () {
  'use strict';
  var cfg = window.KSU_CONFIG || {};
  var src = cfg.backend === 'pocketbase' ? 'pb.js' : 'vendor/supabase.js';
  document.write('<script src="' + src + '"><\/script>');
})();
