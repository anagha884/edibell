-- =============================================================================
-- EDIBELL — Storage buckets, storage policies and Realtime
-- =============================================================================

-- Food photos: publicly readable by URL (paths contain random UUIDs and food
-- photos contain no personal data), max 5 MB, images only. Only donors can
-- upload, and only into their own "<user id>/" folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('food-photos', 'food-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Verification documents: private, max 10 MB, PDF or images. Owner and
-- EDIBELL administrators only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-documents', 'org-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.current_role() returns text language sql stable security definer
set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid()
$$;
revoke all on function app.current_role() from public;
grant usage on schema app to authenticated;
grant execute on function app.current_role(), app.is_admin() to authenticated;

drop policy if exists "food-photos: donors upload to own folder" on storage.objects;
create policy "food-photos: donors upload to own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'food-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select app.current_role()) = 'donor'
  );

drop policy if exists "food-photos: owners read" on storage.objects;
create policy "food-photos: owners read" on storage.objects
  for select to authenticated
  using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "food-photos: owners delete unused" on storage.objects;
create policy "food-photos: owners delete unused" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'food-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.listing_photos lp where lp.storage_path = name)
  );

drop policy if exists "org-documents: owner upload" on storage.objects;
create policy "org-documents: owner upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'org-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "org-documents: owner or admin read" on storage.objects;
create policy "org-documents: owner or admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'org-documents'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or (select app.is_admin())));

-- Realtime: notifications are pushed to the signed-in user (RLS applies).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'notifications') then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end $$;
