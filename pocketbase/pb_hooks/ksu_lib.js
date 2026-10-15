/* KsuNiMeet — общие помощники для хуков PocketBase.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ФУНКЦИИ РЯДОМ С ХУКАМИ.
 * Обработчики хуков выполняются в пуле заранее прогретых JS-движков, и
 * верхнеуровневые функции из `ksu.pb.js` в их области видимости НЕ видны:
 * обработчик получает только «свежий» контекст. Проверено запуском —
 * обращение к такой функции падает с `ReferenceError: ksuNewPhone is not
 * defined`, а клиент видит невнятное «Something went wrong». Поэтому общий
 * код живёт здесь и подключается через require(__hooks + "/ksu_lib.js").
 *
 * ВАЖНО: сервер передаётся сюда ПАРАМЕТРОМ (`app`). Внутри обработчика записи
 * это `e.app` — привязанное к запросу приложение, а не глобальный `$app`;
 * у расписания (cron) хозяин — `$app`.
 */

/* =====================================================================
 * Даты в формате PocketBase
 * ===================================================================== */

/* PocketBase хранит даты как '2026-10-15 02:52:36.731Z' — фиксированная
 * ширина, всегда UTC. Значит, лексикографическое сравнение строк совпадает с
 * хронологическим, и для «старше N минут» не нужно угадывать диалект фильтров
 * для дат: сравниваем строки. */
function ksuStamp(ms) {
  function p2(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function p3(n) {
    if (n < 10) return "00" + n;
    if (n < 100) return "0" + n;
    return "" + n;
  }
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    "-" +
    p2(d.getUTCMonth() + 1) +
    "-" +
    p2(d.getUTCDate()) +
    " " +
    p2(d.getUTCHours()) +
    ":" +
    p2(d.getUTCMinutes()) +
    ":" +
    p2(d.getUTCSeconds()) +
    "." +
    p3(d.getUTCMilliseconds()) +
    "Z"
  );
}

/* =====================================================================
 * Номер KsuNiMeet
 * ===================================================================== */

/* Свободный 8-значный номер. Тот же смысл, что был у ksu_new_phone() в SQL:
 * предлагаем случайный и проверяем, что никто им ещё не владеет. */
function ksuNewPhone(app) {
  for (let i = 0; i < 100; i++) {
    const cand = String(10000000 + Math.floor(Math.random() * 90000000));
    let taken = null;
    try {
      taken = app.findFirstRecordByFilter("profiles", "phone = {:p}", { p: cand });
    } catch (err) {
      // «Ничего не найдено» тоже приходит исключением — это и значит «свободен».
      taken = null;
    }
    if (!taken) return cand;
  }
  // За 100 попыток не нашли при 90 миллионах возможных — практически это
  // означает, что номера кончились. Молча выдать занятый нельзя.
  throw new Error("ksu: не удалось подобрать свободный номер");
}

/* =====================================================================
 * Следующий номер сообщения (монотонный seq)
 * ===================================================================== */

/* Приложение ждёт от `messages.id` число, растущее со временем: в Supabase это
 * был autoincrement, и на нём держатся «сортировка по времени» и вопрос «что
 * новее maxId». У PocketBase id — случайная строка, поэтому выдаём свой номер.
 * Записи сериализует SQLite, а хук работает в той же транзакции, что и
 * вставка, поэтому два одновременных сообщения не получат один номер. */
function ksuNextSeq(app) {
  let next = 1;
  try {
    const rows = app.findRecordsByFilter("messages", "", "-seq", 1, 0);
    if (rows && rows.length) {
      const top = Number(rows[0].get("seq") || 0);
      if (top >= next) next = top + 1;
    }
  } catch (err) {
    // Таблица пуста — начинаем с 1.
  }
  return next;
}

/* =====================================================================
 * Уборка
 * ===================================================================== */

/* ЧТО ЧИСТИТСЯ И ПОЧЕМУ ИМЕННО ТАК:
 *   presence  старше 45 с  — сердцебиение; запись без обновления означает,
 *                            что человек закрыл вкладку. Три тика запаса —
 *                            чтобы моргнувшая сеть не выкидывала из комнаты.
 *   bus       старше 10 мин — «будильники» живут секунды; запас на случай,
 *                            что подписчик спал.
 *   calls     'ringing' > 27 с -> 'missed' — никто не поднял трубку.
 *   rooms     старше 12 ч  — «Смотрим вместе» длиннее фильма: по старому TTL
 *                            в 2 часа комната исчезала бы во время просмотра.
 *   films     чьей комнаты больше нет, либо старше 12 ч — иначе части кино
 *                            остаются на диске навсегда: место занимают, а
 *                            найти их нельзя.
 */
function ksuCleanup(app, nowMs) {
  function olderThan(rec, field, ms) {
    const v = String(rec.get(field) || "");
    if (!v) return false;
    return v < ksuStamp(nowMs - ms);
  }

  /* присутствие */
  let pres = [];
  try {
    pres = app.findRecordsByFilter("presence", "", "", 0, 0);
  } catch (err) {}
  for (let i = 0; i < pres.length; i++) {
    if (olderThan(pres[i], "seen_at", 45000)) app.delete(pres[i]);
  }

  /* пинги */
  let bus = [];
  try {
    bus = app.findRecordsByFilter("bus", "", "", 0, 0);
  } catch (err) {}
  for (let i = 0; i < bus.length; i++) {
    if (olderThan(bus[i], "created_at", 600000)) app.delete(bus[i]);
  }

  /* прозвеневшие впустую звонки */
  let ringing = [];
  try {
    ringing = app.findRecordsByFilter("calls", "state = {:s}", "", 0, 0, { s: "ringing" });
  } catch (err) {}
  for (let i = 0; i < ringing.length; i++) {
    if (olderThan(ringing[i], "created_at", 27000)) {
      ringing[i].set("state", "missed");
      app.save(ringing[i]);
    }
  }

  /* комнаты, которые уже никто не смотрит */
  const liveRooms = {};
  let rooms = [];
  try {
    rooms = app.findRecordsByFilter("rooms", "", "", 0, 0);
  } catch (err) {}
  for (let i = 0; i < rooms.length; i++) {
    const code = String(rooms[i].get("code") || "");
    if (olderThan(rooms[i], "created_at", 12 * 3600000)) {
      app.delete(rooms[i]);
    } else {
      liveRooms[code] = true;
    }
  }

  /* части фильмов, к которым больше нет дороги */
  let films = [];
  try {
    films = app.findRecordsByFilter("films", "", "", 0, 0);
  } catch (err) {}
  for (let i = 0; i < films.length; i++) {
    const room = String(films[i].get("room") || "");
    if (!liveRooms[room] || olderThan(films[i], "created_at", 12 * 3600000)) {
      app.delete(films[i]);
    }
  }
}

module.exports = {
  ksuStamp: ksuStamp,
  ksuNewPhone: ksuNewPhone,
  ksuNextSeq: ksuNextSeq,
  ksuCleanup: ksuCleanup,
};
