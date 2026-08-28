create table "public"."documents" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "attachment_id"      uuid,
  "storage_bucket"     text                     not null default 'bob-uploads'::text,
  "storage_object_ref" text,
  "original_filename"  text                     not null,
  "mime_type"          text                     not null,
  "sha256"             text,
  "uploaded_by"        uuid,
  "source_channel"     text                     not null default 'chat_upload'::text,
  "conversation_id"    uuid,
  "organization_id"    uuid,
  "current_scope"      text                     not null default 'conversation_only'::text,
  "created_at"         timestamp with time zone not null default now(),
  "updated_at"         timestamp with time zone not null default now(),
  constraint "documents_attachment_id_fkey" foreign key (attachment_id) references public.bob_attachments(id) on delete set null,
  constraint "documents_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete set null,
  constraint "documents_current_scope_check"
    check ((current_scope = ANY (ARRAY['conversation_only'::text, 'tenant_reference'::text, 'tenant'::text, 'global_reference'::text, 'quarantined'::text]))),
  constraint "documents_pkey" primary key (id),
  constraint "documents_source_channel_check" check ((source_channel = ANY (ARRAY['chat_upload'::text, 'fetched_url'::text, 'system_generated'::text]))),
  constraint "documents_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "documents_uploaded_by_fkey" foreign key (uploaded_by) references public.user_profiles(id)
);

alter table "public"."documents"
  enable row level security;

create index idx_documents_conversation on public.documents using btree (conversation_id)
  where (conversation_id is not null);

create index idx_documents_org_scope on public.documents using btree (organization_id, current_scope, created_at desc);

create index idx_documents_sha256 on public.documents using btree (sha256)
  where (sha256 is not null);

create unique index uniq_documents_hash_scope on public.documents using btree (sha256, current_scope)
  where (sha256 is not null);

create trigger trg_documents_touch
  before update on public.documents
  for each row
  execute function public.bob_documents_touch_updated_at();

create policy "bob_full_read" on "public"."documents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "documents_select" on "public"."documents"
  for select
  to PUBLIC
  using ((((organization_id is null) AND (current_scope = 'global_reference'::text)) or public.org_access_allowed(organization_id)));

create policy "documents_write" on "public"."documents"
  for all
  to PUBLIC
  using ((((organization_id is not null) AND public.is_admin_for_org(organization_id)) or public.is_grand_master()))
  with check ((((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)) OR public.is_grand_master()));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."documents" to "anon", "authenticated", "postgres", "service_role";

comment on index "public"."uniq_documents_hash_scope" is 'Canonical identity = content hash + scope. Prevents duplicate byte-stores within a scope while keeping tenant vs global material as distinct canonical rows.';

comment on table "public"."documents" is 'Registry row per stored document object. Bytes live in Supabase Storage (bob-uploads); this row holds provenance, tenant scope and discoverability. organization_id null = global/public reference material.';
