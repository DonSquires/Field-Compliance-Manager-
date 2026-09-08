-- Bob receives any file directly into private Storage, including DHFS images.
-- 128 GiB accommodates the observed 115 GiB hidden recording partition.

update storage.buckets
set
  file_size_limit = 137438953472,
  allowed_mime_types = null
where id = 'bob-uploads';

alter table public.bob_attachments
  drop constraint if exists bob_attachments_file_size_bytes_check;

alter table public.bob_attachments
  add constraint bob_attachments_file_size_bytes_check
  check (file_size_bytes > 0 and file_size_bytes <= 137438953472);

comment on constraint bob_attachments_file_size_bytes_check on public.bob_attachments is
  'File size 1 byte through 128 GiB. Any MIME type is stored privately; extraction and inference remain format-specific.';