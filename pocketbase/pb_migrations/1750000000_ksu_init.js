/// <reference path="../pb_data/types.d.ts" />
/* KsuNiMeet — схема для PocketBase.
 *
 * Здесь те же данные, что были в Supabase, но в терминах PocketBase. Имена
 * полей НАРОЧНО совпадают с тем, что уже ждёт браузер (`sender_id`,
 * `recipient_id`, `created_at`): приложение не переписывается, адаптер
 * (public/pb.js) кладёт ответы PocketBase в ту же форму, что отдавал Supabase.
 *
 * ЧТО ПЕРЕЕХАЛО ОТКУДА:
 *   auth.users + profiles   -> profiles           (вход по имени, без почты)
 *   contacts                -> contacts
 *   messages                -> messages           (chat_key считает хук, не клиент)
 *   calls                   -> calls
 *   rooms + room_events     -> rooms + bus        (broadcast вместо postgres_changes)
 *   room_peers              -> presence
 *   storage ksu-films       -> films              (файл-поле, режем так же по 45 МБ)
 *
 * ВАЖНОЕ РЕШЕНИЕ — ПОЧЕМУ ЗДЕСЬ ЕСТЬ `bus` И `presence`.
 * У PocketBase нет broadcast-каналов и presence, как у Supabase Realtime: он
 * умеет только «строка коллекции изменилась». Поэтому «пинг» (будильник,
 * который говорит собеседнику «сходи перечитай») — это запись в `bus`, а
 * «кто сейчас в комнате» — запись с сердцебиением в `presence`. Обе едут по
 * тому же SSE, что и всё остальное, поэтому работают через прокси и не боятся
 * российских 16-килобайтных обрывов (SSE — это обычный HTTP-ответ).
 *
 * В `bus` НЕТ тел сообщений — только «кому», «от кого» и «какого рода событие».
 * Текст берётся из `messages`, где правилом доступа решает база. Подделанный
 * пинг поэтому ничего не показывает.
 *
 * О ФОРМЕ ЗАПИСИ. Поля добавляются через `collection.fields.add(...)`, а не
 * массивом `fields` в конструкторе: конструктор принимает только «сырое» JSON-
 * описание, а экземпляры `new TextField(...)` в нём молча теряются. Проверено
 * запуском — с массивом миграция падает с `passwordAuth: Invalid or missing
 * field username`, потому что поля в коллекции ещё нет.
 */

migrate(
  (app) => {
    /* =================================================================
     * 1. ПРОФИЛИ — вход по имени и паролю, без почты и телефона
     * ================================================================= */
    const profiles = new Collection({ type: "auth", name: "profiles" });
    profiles.fields.add(
      new TextField({
        name: "username",
        required: true,
        min: 3,
        max: 20,
        pattern: "^[A-Za-z0-9_]{3,20}$",
      }),
    );
    // «номер KsuNiMeet», 8 цифр. Проставляет хук (pb_hooks/ksu.pb.js):
    // клиент его не выбирает, иначе можно было бы занять чужой.
    profiles.fields.add(
      new TextField({ name: "phone", required: true, min: 8, max: 8, pattern: "^[0-9]{8}$" }),
    );
    // Почта не нужна вовсе. Поле системное, поэтому его не убрать — но сняв
    // `required`, разрешаем пустое значение у многих записей (уникальный
    // индекс PocketBase для почты построен как `WHERE email != ''`).
    profiles.fields.getByName("email").required = false;
    // Пароль от 6 символов — ровно то, что обещает экран входа. По умолчанию
    // в PocketBase минимум 8, и человек получал бы отказ, которого не понял.
    profiles.fields.getByName("password").min = 6;
    // Вход — по имени. Список полей-идентификаторов заменил почту. Ставится
    // ПОСЛЕ добавления поля `username`, иначе оно «недействительно».
    profiles.passwordAuth.identityFields = ["username"];
    profiles.indexes = [
      "CREATE UNIQUE INDEX `idx_profiles_username` ON `profiles` (username)",
      "CREATE UNIQUE INDEX `idx_profiles_phone` ON `profiles` (phone)",
    ];
    // Поиск человека по имени/номеру нужен вошедшим. Ключ анонимного доступа
    // здесь не секрет, поэтому `@request.auth.id != ""` — не формальность:
    // без него любой из интернета вычитал бы все имена и номера.
    profiles.listRule = '@request.auth.id != ""';
    profiles.viewRule = '@request.auth.id != ""';
    // Регистрация открыта: почты у человека нет, аккаунт создаётся сразу.
    profiles.createRule = "";
    profiles.updateRule = "id = @request.auth.id";
    profiles.deleteRule = "id = @request.auth.id";
    app.save(profiles);

    const profilesId = profiles.id;

    /* =================================================================
     * 2. КОНТАКТЫ
     * ================================================================= */
    const contacts = new Collection({ type: "base", name: "contacts" });
    contacts.fields.add(
      new RelationField({
        name: "owner_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    contacts.fields.add(
      new RelationField({
        name: "peer_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    contacts.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    contacts.indexes = [
      "CREATE UNIQUE INDEX `idx_contacts_pair` ON `contacts` (owner_id, peer_id)",
      "CREATE INDEX `idx_contacts_owner` ON `contacts` (owner_id)",
    ];
    // Контакты — только свои: ни прочитать, ни создать чужую строку нельзя.
    contacts.listRule = "owner_id = @request.auth.id";
    contacts.viewRule = "owner_id = @request.auth.id";
    contacts.createRule = "owner_id = @request.auth.id";
    contacts.updateRule = "owner_id = @request.auth.id";
    contacts.deleteRule = "owner_id = @request.auth.id";
    app.save(contacts);

    /* =================================================================
     * 3. СООБЩЕНИЯ (переписка 1-на-1)
     * ================================================================= */
    /* `seq` — монотонный номер, который выдаёт хук. Зачем он нужен:
     * Supabase отдавал целочисленный autoincrement `id`, и приложение
     * опирается на это — `order('id')` как «по времени», `gt('id', maxId)`
     * как «что пришло после», `Number(m.id)` для сравнения. У PocketBase id
     * случайная строка, поэтому порядок по ней бессмыслен. Адаптер отдаёт
     * приложению `id = seq`, и всё это снова работает. */
    const messages = new Collection({ type: "base", name: "messages" });
    messages.fields.add(new TextField({ name: "chat_key", required: false, max: 64 }));
    messages.fields.add(new NumberField({ name: "seq", required: false, onlyInt: true }));
    messages.fields.add(
      new RelationField({
        name: "sender_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    messages.fields.add(
      new RelationField({
        name: "recipient_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    messages.fields.add(new TextField({ name: "body", required: false, max: 4000 }));
    messages.fields.add(new DateField({ name: "read_at", required: false }));
    messages.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    messages.indexes = [
      "CREATE UNIQUE INDEX `idx_messages_seq` ON `messages` (seq)",
      "CREATE INDEX `idx_messages_chat` ON `messages` (chat_key, seq)",
      "CREATE INDEX `idx_messages_unread` ON `messages` (recipient_id)",
    ];
    messages.listRule = "sender_id = @request.auth.id || recipient_id = @request.auth.id";
    messages.viewRule = "sender_id = @request.auth.id || recipient_id = @request.auth.id";
    // Писать можно только от своего имени — подделать отправителя нельзя.
    messages.createRule = "sender_id = @request.auth.id";
    // Прочитанным отмечает только получатель (как было в PHP-версии).
    messages.updateRule = "recipient_id = @request.auth.id";
    messages.deleteRule = null;
    app.save(messages);

    /* =================================================================
     * 4. ЗВОНКИ
     * ================================================================= */
    const calls = new Collection({ type: "base", name: "calls" });
    calls.fields.add(
      new RelationField({
        name: "caller_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    calls.fields.add(
      new RelationField({
        name: "callee_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    calls.fields.add(
      new SelectField({
        name: "state",
        required: true,
        maxSelect: 1,
        values: ["ringing", "answered", "missed", "declined", "cancelled", "ended"],
      }),
    );
    calls.fields.add(new BoolField({ name: "video" }));
    calls.fields.add(new TextField({ name: "room_code", required: false, max: 10 }));
    calls.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    calls.fields.add(new AutodateField({ name: "updated_at", onCreate: true, onUpdate: true }));
    calls.indexes = [
      "CREATE INDEX `idx_calls_callee` ON `calls` (callee_id, state)",
      "CREATE INDEX `idx_calls_caller` ON `calls` (caller_id, state)",
    ];
    calls.listRule = "caller_id = @request.auth.id || callee_id = @request.auth.id";
    calls.viewRule = "caller_id = @request.auth.id || callee_id = @request.auth.id";
    calls.createRule = "caller_id = @request.auth.id";
    // Трубку поднимает и кладёт любой из двоих.
    calls.updateRule = "caller_id = @request.auth.id || callee_id = @request.auth.id";
    calls.deleteRule = "caller_id = @request.auth.id || callee_id = @request.auth.id";
    app.save(calls);

    /* =================================================================
     * 5. КОМНАТЫ «СМОТРИМ ВМЕСТЕ»
     * ================================================================= */
    const rooms = new Collection({ type: "base", name: "rooms" });
    rooms.fields.add(new TextField({ name: "code", required: true, min: 5, max: 5 }));
    rooms.fields.add(
      new RelationField({
        name: "host_id",
        required: true,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: true,
      }),
    );
    // Фильм: имя, размер, готовность. Состояние пульта (пауза/плей/
    // перемотка) сюда не пишем — оно летит по `bus`, потому что важно
    // мгновенно, а не «когда-нибудь».
    rooms.fields.add(new JSONField({ name: "movie", required: false }));
    rooms.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    rooms.indexes = ["CREATE UNIQUE INDEX `idx_rooms_code` ON `rooms` (code)"];
    // Комната открывается по коду, а код (5 случайных символов) и есть
    // секрет: без него чужую комнату не найти.
    rooms.listRule = '@request.auth.id != ""';
    rooms.viewRule = '@request.auth.id != ""';
    rooms.createRule = "host_id = @request.auth.id";
    rooms.updateRule = "host_id = @request.auth.id";
    rooms.deleteRule = "host_id = @request.auth.id";
    app.save(rooms);

    /* =================================================================
     * 6. BUS — сигналинг и «пинг» (замена broadcast)
     * ================================================================= */
    /* topic — имя канала из приложения ('ksu-user-<id>', 'ksu-room-<код>',
     * 'ksu-call-<код>'). Все подписываются на коллекцию, а нужный канал
     * выбирают на клиенте: у PocketBase подписка не бывает с фильтром по
     * полю. При 30–50 пользователях это несколько событий в минуту.
     * Payload хранит полезное только для сигналинга WebRTC (SDP и ICE) —
     * то есть обмен, который и так идёт через сервер. */
    const bus = new Collection({ type: "base", name: "bus" });
    bus.fields.add(new TextField({ name: "topic", required: true, max: 80 }));
    bus.fields.add(new TextField({ name: "ev", required: false, max: 40 }));
    bus.fields.add(new JSONField({ name: "payload", required: false }));
    bus.fields.add(
      new RelationField({
        name: "sender_id",
        required: false,
        collectionId: profilesId,
        maxSelect: 1,
        cascadeDelete: false,
      }),
    );
    bus.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    bus.indexes = ["CREATE INDEX `idx_bus_topic` ON `bus` (topic, created_at)"];
    bus.listRule = '@request.auth.id != ""';
    bus.viewRule = '@request.auth.id != ""';
    bus.createRule = '@request.auth.id != ""';
    bus.updateRule = null;
    bus.deleteRule = null;
    app.save(bus);

    /* =================================================================
     * 7. PRESENCE — «кто сейчас в комнате» (замена presence-канала)
     * ================================================================= */
    /* Сердцебиение: клиент переписывает `seen_at` каждые несколько секунд,
     * а уборщик удаляет записи старше минуты. Выход виден не мгновенно, а
     * через один тик — это честная цена того, что у PocketBase нет
     * «подписчик отключился». */
    const presence = new Collection({ type: "base", name: "presence" });
    presence.fields.add(new TextField({ name: "topic", required: true, max: 80 }));
    presence.fields.add(new TextField({ name: "pkey", required: true, max: 80 }));
    presence.fields.add(new JSONField({ name: "state", required: false }));
    presence.fields.add(new DateField({ name: "seen_at", required: false }));
    presence.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    presence.indexes = ["CREATE UNIQUE INDEX `idx_presence_key` ON `presence` (topic, pkey)"];
    presence.listRule = '@request.auth.id != ""';
    presence.viewRule = '@request.auth.id != ""';
    presence.createRule = '@request.auth.id != ""';
    presence.updateRule = '@request.auth.id != ""';
    presence.deleteRule = '@request.auth.id != ""';
    app.save(presence);

    /* =================================================================
     * 8. FILMS — хранилище кинолент (замена bucket ksu-films)
     * ================================================================= */
    /* У PocketBase нет «папок в бакете»: файл живёт полем записи. Поэтому
     * путь из старого кода `<код>/<id фильма>/<номер части>` разложен на три
     * поля, а сам файл — в `blob`. Режем ровно так же по 45 МБ: маленькая
     * часть доезжает через нестабильный канал, большая — нет.
     * `maxSize` поднят с 5 МБ по умолчанию до 48 МБ — иначе загрузка
     * отваливалась бы на первой же части. */
    const films = new Collection({ type: "base", name: "films" });
    films.fields.add(new TextField({ name: "room", required: true, max: 10 }));
    films.fields.add(new TextField({ name: "movie", required: true, max: 40 }));
    /* ВНИМАНИЕ: `required` здесь НАРОЧНО false, и это не небрежность.
     * У числового поля PocketBase «пусто» и «ноль» — одно и то же значение,
     * поэтому `required: true` отвергает 0 с ошибкой `validation_required`
     * («Cannot be blank»). А приложение нумерует части фильма С НУЛЯ, так что
     * первая часть не залилась бы никогда. Проверено запуском: idx=1 проходит,
     * idx=0 падает с 400. Обязательность поля не теряется — адаптер всегда
     * присылает idx, а от дублей защищает уникальный индекс (room, movie, idx). */
    films.fields.add(new NumberField({ name: "idx", required: false, onlyInt: true }));
    films.fields.add(
      new FileField({
        name: "blob",
        required: true,
        maxSelect: 1,
        maxSize: 50331648, // 48 МиБ; часть — 45 МиБ, остаток на заголовки
      }),
    );
    films.fields.add(new AutodateField({ name: "created_at", onCreate: true, onUpdate: false }));
    films.indexes = [
      "CREATE UNIQUE INDEX `idx_films_part` ON `films` (room, movie, idx)",
      "CREATE INDEX `idx_films_room` ON `films` (room)",
    ];
    // Код комнаты — и есть ключ доступа: чужой фильм без кода не найти.
    films.listRule = '@request.auth.id != ""';
    films.viewRule = '@request.auth.id != ""';
    films.createRule = '@request.auth.id != ""';
    films.updateRule = '@request.auth.id != ""';
    films.deleteRule = '@request.auth.id != ""';
    app.save(films);

    /* =================================================================
     * 9. ДЕФОЛТНАЯ КОЛЛЕКЦИЯ users — УБРАТЬ
     * ================================================================= */
    // PocketBase создаёт auth-коллекцию `users` «из коробки». Мы её не
    // используем, а лишняя открытая коллекция — это лишняя поверхность
    // атаки и лишний вопрос «а это что такое».
    try {
      app.delete(app.findCollectionByNameOrId("users"));
    } catch (err) {
      // Уже удалена (повторный прогон миграции) — не ошибка.
    }
  },

  (app) => {
    // Откат: сносим всё, что создали, в порядке зависимостей.
    const names = [
      "films",
      "presence",
      "bus",
      "rooms",
      "calls",
      "messages",
      "contacts",
      "profiles",
    ];
    for (let i = 0; i < names.length; i++) {
      try {
        app.delete(app.findCollectionByNameOrId(names[i]));
      } catch (err) {}
    }
  },
);
