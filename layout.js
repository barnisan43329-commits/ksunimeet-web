/* KsuNiMeet — размеры видимой области экрана.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Три разные «кривые вёрстки» в этом приложении растут
 * из одного корня: коробки считаются от БОЛЬШОГО вьюпорта, а человек видит
 * маленький.
 *
 *   1) `100vh` на телефоне — это высота БЕЗ адресной строки. Пока адресная
 *      строка на экране, любая коробка «во весь экран» уходит под неё. В
 *      альбомной ориентации адресная строка съедает почти всю высоту, поэтому
 *      кадр обрезается сильнее всего именно при повороте.
 *   2) `100vw` не учитывает вырез и домашнюю полосу, а `viewport-fit=cover`
 *      (он включён на всех трёх страницах) разрешает вёрстке заходить прямо
 *      под них. В портретной ориентации это верх и низ, в альбомной — БОКА.
 *   3) Поворот не пересчитывал ничего: обработчик звал только пересчёт формы
 *      кадра, а размеры коробки оставались прежними до следующей смены.
 *
 * ЧТО ДЕЛАЕТ. Кладёт на <html> четыре переменные с видимым прямоугольником
 * (visualViewport) и обновляет их на всех событиях, после которых размеры
 * меняются: поворот, показ/скрытие адресной строки, клавиатура, настоящий
 * полный экран, изменение размера окна на компьютере.
 *
 * Переменные только в CSS — никаких размеров в пикселях из JS: страницы
 * вычитают их в calc() и вычитают там же env(safe-area-inset-*), поэтому
 * вырез учитывается и в альбомной ориентации, а не только сверху.
 *
 * КОГДА ЭТОГО ФАЙЛА НЕТ (старый WebView, кэш, отключённый скрипт), каждая
 * страница всё равно остаётся рабочей: в каждом calc() есть запасное значение
 * (100vw / 100vh / 0px), то есть вёрстка откатывается к обычному поведению.
 *
 * Совместимость: Android 8, WebView ~Chrome 60 — поэтому var, без стрелок,
 * без шаблонных строк. visualViewport есть в Chrome 61+, но проверка на его
 * отсутствие всё равно есть: тогда берём innerWidth/innerHeight.
 */
(function () {
  'use strict';

  if (window.KSU_LAYOUT) return;

  var root = document.documentElement;
  var watchers = [];
  var last = '';

  function vv() { return window.visualViewport || null; }

  function sizes() {
    var v = vv();
    return {
      width: v ? v.width : window.innerWidth,
      height: v ? v.height : window.innerHeight,
      top: v ? v.offsetTop : 0,
      left: v ? v.offsetLeft : 0,
      scale: v && v.scale ? v.scale : 1
    };
  }

  function apply() {
    var s = sizes();
    var key = [s.width, s.height, s.top, s.left].join('|');
    if (key === last) return;
    last = key;
    root.style.setProperty('--ksu-vv-w', Math.round(s.width) + 'px');
    root.style.setProperty('--ksu-vv-h', Math.round(s.height) + 'px');
    root.style.setProperty('--ksu-vv-top', Math.round(s.top) + 'px');
    root.style.setProperty('--ksu-vv-left', Math.round(s.left) + 'px');
    for (var i = 0; i < watchers.length; i++) {
      try { watchers[i](s); } catch (e) {}
    }
  }

  /* Поворот сообщается РАНЬШЕ, чем браузер пересчитал visualViewport: одиночный
   * вызов сразу после события отдаёт старые числа. Поэтому пересчитываем три
   * раза — в кадре, через 80 мс и через 300 мс (столько занимает переезд
   * адресной строки и пересчёт выреза). Лишние вызовы отсекает сравнение key. */
  function soon() {
    apply();
    if (window.requestAnimationFrame) window.requestAnimationFrame(apply);
    setTimeout(apply, 80);
    setTimeout(apply, 300);
  }

  window.addEventListener('resize', soon);
  window.addEventListener('orientationchange', soon);
  document.addEventListener('fullscreenchange', soon);
  document.addEventListener('webkitfullscreenchange', soon);
  if (window.screen && screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', soon);
  } else if (window.screen && screen.orientation && screen.orientation.onchange === null) {
    screen.orientation.onchange = soon;
  }
  var v = vv();
  if (v && v.addEventListener) {
    v.addEventListener('resize', soon);
    // visualViewport.scroll — это и есть «адресная строка уехала».
    v.addEventListener('scroll', soon);
  }

  window.KSU_LAYOUT = {
    sizes: sizes,
    apply: soon,
    onChange: function (cb) {
      if (typeof cb === 'function') { watchers.push(cb); try { cb(sizes()); } catch (e) {} }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', soon);
  else soon();
})();
