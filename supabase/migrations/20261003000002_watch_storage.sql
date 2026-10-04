-- KsuNiMeet — хранилище для «Смотрим вместе».
--
-- Фильм НЕ отдаётся потоком с сервера (в России это и не заработало бы):
-- хост один раз заливает файл, гость один раз скачивает, дальше оба смотрят
-- свой локальный файл, а по сети летят только команды пульта — несколько
-- байт. Поэтому здесь нужен только bucket, а не раздача видео.
--
-- ВАЖНО ПРО РАЗМЕР: бесплатный тариф Supabase не принимает объект больше
-- 50 МБ (проверено: PATCH fileSizeLimit → 402). Поэтому фильм режется на
-- части по 45 МБ и каждая часть лежит отдельным объектом:
--   <код комнаты>/<id фильма>/0, /1, /2 …
-- Гость скачивает части по очереди и склеивает их в Blob — Chrome держит
-- такие blob'ы на диске, а не в памяти, поэтому и полуторачасовой фильм
-- не «съедает» телефон.

insert into storage.buckets (id, name, public)
values ('ksu-films', 'ksu-films', false)
on conflict (id) do nothing;

-- Читать и писать может только вошедший. Код комнаты — это и есть секрет
-- (5 символов, комната живёт 2 часа), а чужие объекты без кода не найти.
drop policy if exists ksu_films_read on storage.objects;
create policy ksu_films_read on storage.objects
  for select using (bucket_id = 'ksu-films' and auth.uid() is not null);

drop policy if exists ksu_films_write on storage.objects;
create policy ksu_films_write on storage.objects
  for insert with check (bucket_id = 'ksu-films' and auth.uid() is not null);

-- Перезапись нужна, если хост поменял фильм в той же комнате.
drop policy if exists ksu_films_update on storage.objects;
create policy ksu_films_update on storage.objects
  for update using (bucket_id = 'ksu-films' and auth.uid() is not null)
  with check (bucket_id = 'ksu-films' and auth.uid() is not null);

drop policy if exists ksu_films_delete on storage.objects;
create policy ksu_films_delete on storage.objects
  for delete using (bucket_id = 'ksu-films' and auth.uid() is not null);
