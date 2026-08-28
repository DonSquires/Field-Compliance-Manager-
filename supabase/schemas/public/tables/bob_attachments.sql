create table "public"."bob_attachments" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "conversation_id"    uuid                     not null,
  "uploaded_by"        uuid                     not null,
  "file_name"          text                     not null,
  "file_type"          text                     not null,
  "file_size_bytes"    bigint                   not null,
  "storage_bucket"     text                     not null default 'bob-uploads'::text,
  "storage_path"       text                     not null,
  "purpose"            text                     not null,
  "processing_state"   text                     not null default 'pending'::text,
  "extraction_summary" text,
  "extraction_payload" jsonb                    not null default '{}'::jsonb,
  "confidence"         real,
  "created_at"         timestamp with time zone not null default now(),
  "updated_at"         timestamp with time zone not null default now(),
  "source_type"        text                     not null default 'upload'::text,
  "source_url"         text,
  constraint "bob_attachments_confidence_check" check (((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))),
  constraint "bob_attachments_file_size_bytes_check" check (((file_size_bytes > 0) AND (file_size_bytes <= 52428800))),
  constraint "bob_attachments_pkey" primary key (id),
  constraint "bob_attachments_processing_state_check"
    check ((processing_state = ANY (ARRAY['pending'::text, 'processing'::text, 'extracted'::text, 'failed'::text, 'manual_review_required'::text]))),
  constraint "bob_attachments_purpose_check" check ((purpose = ANY (ARRAY['document_intake'::text, 'photo_intake'::text]))),
  constraint "bob_attachments_source_type_check" check ((source_type = ANY (ARRAY['upload'::text, 'url'::text]))),
  constraint "bob_attachments_storage_bucket_check" check ((storage_bucket = 'bob-uploads'::text)),
  constraint "bob_attachments_storage_bucket_storage_path_key" unique (storage_bucket, storage_path),
  constraint "bob_attachments_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete cascade,
  constraint "bob_attachments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "bob_attachments_uploaded_by_fkey" foreign key (uploaded_by) references public.user_profiles(id)
);

alter table "public"."bob_attachments"
  enable row level security;

create index bob_attachments_org_conversation_idx on public.bob_attachments using btree (organization_id, conversation_id, created_at desc);

create policy "bob_attachments_insert" on "public"."bob_attachments"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_attachments_select" on "public"."bob_attachments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_attachments_update" on "public"."bob_attachments"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_attachments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_attachments" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_attachments"."source_type" is 'How this attachment reached Bob: upload (browser file upload, the original 0012 path) or url (Bob fetched readable text from an explicit external URL, e.g. a council bylaw publication page). Both converge on the same storage_bucket/storage_path contract and the same extraction pipeline. #74.';

comment on column "public"."bob_attachments"."source_url" is 'The external URL this attachment was fetched from, when source_type=''url''. Null for uploads. Preserved for audit -- a bylaw''s legal authority depends on knowing exactly which published version was read. #74.';

comment on constraint "bob_attachments_file_size_bytes_check" on "public"."bob_attachments" is 'File size 1 byte .. 50 MB (52428800). Raised from 10 MB in 0142 to match the bob-uploads bucket (50 MB) + client cap (48 MB). 50 MB is the Supabase project per-file hard limit.';

comment on table "public"."bob_attachments" is 'Private Bob document/photo intake metadata. File bytes live in private Supabase Storage; high-impact extracted actions require approval.';
