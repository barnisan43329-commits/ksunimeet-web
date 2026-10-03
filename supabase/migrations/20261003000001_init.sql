-- KsuNiMeet on Supabase — схема, права доступа и realtime.
--
-- Что здесь есть: всё, чем раньше управляли JSON-файлы на хостинге
-- (data/users, data/chats, data/calls, data/rooms, data/uploads, data/push).
-- Один в один по смыслу, но с настоящими ограничениями целостности и с
-- правилами доступа (RLS) вместо проверок в PHP.
--
-- ЧТО ПЕРЕЕХАЛО КУДА:
--   data/users/*.json     -> profiles        (+ auth.users для пароля)
--   data/index.json       -> profiles.phone / profiles.username (уникальные)
--   контакты в users/*    -> contacts
--   data/chats/*.json     -> messages        (chat_key = пара uid по возрастанию)
--   data/calls/*.json     -> calls
--   data/rooms/*.json     -> rooms + room_events
--   data/uploads/*        -> attachments + Supabase Storage
--   data/push/*.json      -> push_subscriptions

-- =====================================================================
-- 1. ПРОФИЛИ
-- =====================================================================
-- Вход как раньше: имя + пароль, без почты и телефона. Supabase Auth
-- требует email, поэтому синтезируем его из имени:
--   barni  ->  barni@ksunimeet.local
-- Пользователь этого адреса никогда не видит и писем на него нет.

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  phone       char(8) not null unique,          -- «номер KsuNiMeet», 8 цифр
  created_at  timestamptz not null default now(),
  constraint profiles_username_ok check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint profiles_phone_ok    check (phone ~ '^[0-9]{8}$')
);

-- Индексы под поиск человека (action=search) по имени и по номеру.
create index if not exists profiles_username_lower_idx on public.profiles (lower(username));

-- Свободный 8-значный номер. Аналог ksu_phone_new(): занимаем и проверяем,
-- что никто им ещё не владеет.
create or replace function public.ksu_new_phone()
returns char(8)
language plpgsql
as $$
declare
  candidate char(8);
begin
  loop
    candidate := lpad((floor(random() * 90000000) + 10000000)::bigint::text, 8, '0');
    exit when not exists (select 1 from public.profiles p where p.phone = candidate);
  end loop;
  return candidate;
end;
$$;

-- Профиль создаётся сам при регистрации. Приложение кладёт имя в
-- options.data.username — здесь оно превращается в строку profiles.
create or replace function public.ksu_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired text;
begin
  desired := coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), 'user' || substr(new.id::text, 1, 6));
  -- на всякий случай приводим к допустимому алфавиту
  desired := regexp_replace(desired, '[^A-Za-z0-9_]', '_', 'g');
  if char_length(desired) < 3 then
    desired := desired || substr(new.id::text, 1, 4);
  end if;
  if char_length(desired) > 20 then
    desired := substr(desired, 1, 20);
  end if;

  insert into public.profiles (id, username, phone)
  values (new.id, desired, public.ksu_new_phone())
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists ksu_on_auth_user_created on auth.users;
create trigger ksu_on_auth_user_created
  after insert on auth.users
  for each row execute function public.ksu_handle_new_user();

-- =====================================================================
-- 2. КОНТАКТЫ
-- =====================================================================
create table if not exists public.contacts (
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  peer_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (owner_id, peer_id),
  constraint contacts_not_self check (owner_id <> peer_id)
);

create index if not exists contacts_owner_idx on public.contacts (owner_id);

-- =====================================================================
-- 3. ВЛОЖЕНИЯ (фото/видео/документы)
-- =====================================================================
-- Сам файл лежит в Supabase Storage (bucket ksu-att), а строкa здесь —
-- это метаданные и права: кому файл виден (раньше — data/uploads/*.json).
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  peer_id     uuid references public.profiles(id) on delete set null,
  kind        text not null check (kind in ('img','vid','doc','audio')),
  mime        text not null,
  name        text not null,
  size_bytes  bigint not null default 0,
  storage_path text not null,                   -- путь в bucket
  thumb_path  text,                             -- маленькая копия для пузыря
  created_at  timestamptz not null default now()
);

create index if not exists attachments_owner_idx on public.attachments (owner_id);
create index if not exists attachments_peer_idx  on public.attachments (peer_id);

-- =====================================================================
-- 4. СООБЩЕНИЯ (переписка 1-на-1, как iMessage)
-- =====================================================================
-- chat_key — те же двое, всегда по возрастанию id, чтобы одна пара имела
-- ровно один «канал». Это замена ksu_chat_path(), где имя файла тоже не
-- зависело от направления.
create table if not exists public.messages (
  id          bigint generated by default as identity primary key,
  chat_key    text not null,
  sender_id   uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body        text not null default '',
  att_id      uuid references public.attachments(id) on delete set null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

create index if not exists messages_chat_idx on public.messages (chat_key, id);
create index if not exists messages_unread_idx on public.messages (recipient_id) where read_at is null;

-- chat_key считаем на сервере: приложению не нужно знать правило сортировки.
create or replace function public.ksu_chat_key(a uuid, b uuid)
returns text
language sql
immutable
as $$
  select least(a::text, b::text) || '|' || greatest(a::text, b::text);
$$;

create or replace function public.ksu_messages_set_key()
returns trigger
language plpgsql
as $$
begin
  new.chat_key := public.ksu_chat_key(new.sender_id, new.recipient_id);
  return new;
end;
$$;

drop trigger if exists ksu_messages_key on public.messages;
create trigger ksu_messages_key
  before insert or update of sender_id, recipient_id on public.messages
  for each row execute function public.ksu_messages_set_key();

-- =====================================================================
-- 5. ЗВОНКИ
-- =====================================================================
create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  caller_id   uuid not null references public.profiles(id) on delete cascade,
  callee_id   uuid not null references public.profiles(id) on delete cascade,
  state       text not null default 'ringing'
              check (state in ('ringing','answered','missed','declined','cancelled','ended')),
  video       boolean not null default false,
  room_code   char(5),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists calls_callee_open_idx on public.calls (callee_id, state);
create index if not exists calls_caller_open_idx on public.calls (caller_id, state);

-- Звонок перестаёт быть «живым» сам: прозвенел без ответа — missed.
create or replace function public.ksu_expire_ringing()
returns void
language sql
security definer
set search_path = public
as $$
  update public.calls
     set state = 'missed', updated_at = now()
   where state = 'ringing'
     and created_at < now() - interval '27 seconds';
$$;

-- =====================================================================
-- 6. КОМНАТЫ + СИГНАЛИНГ «СМОТРИМ ВМЕСТЕ»
-- =====================================================================
create table if not exists public.rooms (
  code        char(5) primary key,
  host_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  movie       jsonb,            -- фильм: имя, размер, готовность
  sync        jsonb,            -- последняя команда пульта (пауза/плей/перемотка)
  sync_seq    bigint not null default 0,
  ctrl        jsonb,            -- заявка гостя на управление
  ctrl_seq    bigint not null default 0,
  grant       boolean not null default false,   -- разрешено ли гостю управлять
  grant_at    bigint not null default 0
);

-- События комнаты: сигналинг WebRTC и пульт. Раньше всё это лежало в
-- ОДНОМ JSON-файле комнаты (и терялось при гонке — см. ksu_room_update).
-- Здесь каждая запись отдельной строкой, поэтому терять нечего.
create table if not exists public.room_events (
  id          bigint generated by default as identity primary key,
  room_code   char(5) not null references public.rooms(code) on delete cascade,
  kind        text not null check (kind in ('signal','sync','ctrl','grant','peer','movie')),
  sender_id   uuid references public.profiles(id) on delete set null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists room_events_room_idx on public.room_events (room_code, id);

-- Кто сейчас в комнате (живое присутствие). Раньше — room.peers с
-- меткой времени; здесь список + Realtime, чтобы «вышел» было мгновенным.
create table if not exists public.room_peers (
  room_code   char(5) not null references public.rooms(code) on delete cascade,
  role        char(1) not null check (role in ('A','B')),
  user_id     uuid references public.profiles(id) on delete set null,
  name        text not null default '',
  seen_at     timestamptz not null default now(),
  primary key (room_code, role)
);

-- =====================================================================
-- 7. PUSH-ПОДПИСКИ
-- =====================================================================
-- Тела подписок те же, что и раньше (endpoint + p256dh + auth). Саму
-- отправку придётся делать Edge Function: VAPID-подпись требует
-- приватного ключа, которого не должно быть в браузере.
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists push_user_idx on public.push_subscriptions (user_id);

-- =====================================================================
-- 8. ПРАВИЛА ДОСТУПА (RLS)
-- =====================================================================
-- Ключевая разница с PHP: раньше защита была в коде сервера, теперь её
-- описывает сама база. Даже если кто-то подменит запрос из браузера,
-- база не отдаст чужие строки.

alter table public.profiles            enable row level security;
alter table public.contacts            enable row level security;
alter table public.attachments         enable row level security;
alter table public.messages            enable row level security;
alter table public.calls               enable row level security;
alter table public.rooms               enable row level security;
alter table public.room_events         enable row level security;
alter table public.room_peers          enable row level security;
alter table public.push_subscriptions  enable row level security;

-- profiles: свой профиль читаю и правлю; чужой — только чтобы найти человека
-- по имени или номеру.
--
-- ВАЖНО: anon-ключ публичный (он уезжает в статический сайт), поэтому
-- `using (true)` здесь был бы ошибкой — любой с этим ключом вычитал бы ВСЕ
-- имена и номера. Требуем вход: поиск доступен вошедшим, гостя база не пустит.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

-- contacts: вижу и правлю только свои контакты.
drop policy if exists contacts_rw_owner on public.contacts;
create policy contacts_rw_owner on public.contacts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- attachments: вижу своё или то, что адресовано мне.
drop policy if exists attachments_select_mine on public.attachments;
create policy attachments_select_mine on public.attachments
  for select using (owner_id = auth.uid() or peer_id = auth.uid());

drop policy if exists attachments_insert_mine on public.attachments;
create policy attachments_insert_mine on public.attachments
  for insert with check (owner_id = auth.uid());

-- messages: только свои переписки (я отправитель или получатель).
drop policy if exists messages_select_mine on public.messages;
create policy messages_select_mine on public.messages
  for select using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists messages_insert_mine on public.messages;
create policy messages_insert_mine on public.messages
  for insert with check (sender_id = auth.uid());

-- прочитанным может отметить только получатель (как в PHP)
drop policy if exists messages_update_read on public.messages;
create policy messages_update_read on public.messages
  for update using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- calls: вижу только звонки со своим участием.
drop policy if exists calls_select_mine on public.calls;
create policy calls_select_mine on public.calls
  for select using (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists calls_insert_caller on public.calls;
create policy calls_insert_caller on public.calls
  for insert with check (caller_id = auth.uid());

-- состояние меняет любой из двоих (ответить, отклонить, завершить)
drop policy if exists calls_update_participant on public.calls;
create policy calls_update_participant on public.calls
  for update using (caller_id = auth.uid() or callee_id = auth.uid())
  with check (caller_id = auth.uid() or callee_id = auth.uid());

-- rooms: читать может вошедший по коду, создаёт только хост.
drop policy if exists rooms_select_all on public.rooms;
create policy rooms_select_all on public.rooms
  for select using (auth.uid() is not null);

drop policy if exists rooms_insert_host on public.rooms;
create policy rooms_insert_host on public.rooms
  for insert with check (host_id = auth.uid());

drop policy if exists rooms_update_host on public.rooms;
create policy rooms_update_host on public.rooms
  for update using (host_id = auth.uid()) with check (host_id = auth.uid());

-- room_events: в комнату по коду пишет любой вошедший (сигналинг WebRTC).
drop policy if exists room_events_select_all on public.room_events;
create policy room_events_select_all on public.room_events
  for select using (auth.uid() is not null);

drop policy if exists room_events_insert_auth on public.room_events;
create policy room_events_insert_auth on public.room_events
  for insert with check (sender_id = auth.uid());

-- room_peers: своё место занимаю и отпускаю сам.
drop policy if exists room_peers_select_all on public.room_peers;
create policy room_peers_select_all on public.room_peers
  for select using (auth.uid() is not null);

drop policy if exists room_peers_rw_self on public.room_peers;
create policy room_peers_rw_self on public.room_peers
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- push_subscriptions: только свои.
drop policy if exists push_rw_self on public.push_subscriptions;
create policy push_rw_self on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- 9. REALTIME
-- =====================================================================
-- Вместо опроса каждые 1,2 с (и двух круговых рейсов на тик) браузер
-- держит подписку, а сервер сам присылает новые строки. Это и есть
-- замена poll/me/msglist.
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.calls;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.room_events;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.room_peers;
  exception when duplicate_object then null; end;
end $$;

-- Realtime присылает и «старое» значение строки; для чата это лишний вес.
alter table public.messages    replica identity default;
alter table public.calls       replica identity default;
alter table public.room_events replica identity default;

-- =====================================================================
-- 10. ЧИСТКА ЗАПИСЕЙ
-- =====================================================================
-- Раньше TTL был в PHP (комната живёт 2 часа, брошенные фильмы — 12 ч).
-- Теперь за это отвечает pg_cron; если расширение недоступно, те же
-- условия можно вызывать по расписанию из Edge Function.
create or replace function public.ksu_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  -- звонки, прозвеневшие впустую
  select public.ksu_expire_ringing();
  -- комнаты старше 2 часов вместе с событиями (каскадом)
  delete from public.rooms where created_at < now() - interval '2 hours';
$$;
