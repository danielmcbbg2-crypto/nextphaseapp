-- Storage for product clips: public to watch (they're on the shop), MP4 or WebM only, up to 25 MB,
-- and only store managers can add or remove them. (The photos bucket takes images only.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('product-videos', 'product-videos', true, 26214400, array['video/mp4', 'video/webm'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy product_videos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'product-videos' and public.has_perm('canManageStore'));
create policy product_videos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-videos' and public.has_perm('canManageStore'));
