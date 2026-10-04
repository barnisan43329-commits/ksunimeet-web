-- =====================================================================
-- 11. ЧИСТКА ПО РАСПИСАНИЮ + УДАЛЕНИЕ СВОИХ ЗАПИСЕЙ
-- =====================================================================
-- ksu_cleanup() из первой миграции был написан, но никем не вызывался:
-- брошенные комнаты и «прозвеневшие» звонки копились бы вечно. pg_cron в
-- проекте доступен (1.6.4), ставим его и запускаем чистку каждые 5 минут.
create extension if not exists pg_cron;

-- Срок жизни комнаты поднят с 2 до 12 часов. «Смотрим вместе» — не
-- короткий сеанс: полнометражный фильм идёт дольше двух часов, и по старому
-- TTL комната исчезала бы прямо во время просмотра (вместе с синхронизацией).
-- 12 часов совпадает со сроком жизни брошенных фильмов в старой версии.
create or replace function public.ksu_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  select public.ksu_expire_ringing();
  delete from public.rooms where created_at < now() - interval '12 hours';
$$;

-- Повторный вызов с тем же именем обновляет задание — миграция идемпотентна.
select cron.schedule('ksu-cleanup', '*/5 * * * *', $$select public.ksu_cleanup()$$);

-- RLS не давала удалять ничего: политик на DELETE не было вовсе, поэтому
-- REST-DELETE возвращал 204, а строка оставалась. Разрешаем удалять СВОЁ.
-- Комнату убирает только хост; события и присутствие уедут каскадом.
drop policy if exists rooms_delete_host on public.rooms;
create policy rooms_delete_host on public.rooms
  for delete using (host_id = auth.uid());

-- Свой звонок (как звонивший или как принявший) можно удалить после разговора.
drop policy if exists calls_delete_participant on public.calls;
create policy calls_delete_participant on public.calls
  for delete using (caller_id = auth.uid() or callee_id = auth.uid());
