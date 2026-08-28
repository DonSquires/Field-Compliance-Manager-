create table "public"."document_upload_events" (
  "id"                uuid                     not null default gen_random_uuid(),
  "document_id"       uuid,
  "attachment_id"     uuid,
  "sha256"            text                     not null,
  "original_filename" text                     not null,
  "mime_type"         text,
  "uploaded_by"       uuid,
  "organization_id"   uuid,
  "conversation_id"   uuid,
  "source_channel"    text                     not null default 'chat_upload'::text,
  "was_deduplicated"  boolean                  not null default false,
  "created_at"        timestamp with time zone not null default now(),
  constraint "document_upload_events_attachment_id_fkey" foreign key (attachment_id) references public.bob_attachments(id) on delete set null,
  constraint "document_upload_events_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete set null,
  constraint "document_upload_events_pkey" primary key (id),
  constraint "document_upload_events_source_channel_check" check ((source_channel = ANY (ARRAY['chat_upload'::text, 'fetched_url'::text, 'system_generated'::text]))),
  constraint "document_upload_events_document_id_fkey" foreign key (document_id) references public.documents(id) on delete set null,
  constraint "document_upload_events_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "document_upload_events_uploaded_by_fkey" foreign key (uploaded_by) references public.user_profiles(id)
);

alter table "public"."document_upload_events"
  enable row level security;

create index idx_document_upload_events_doc on public.document_upload_events using btree (document_id, created_at desc);

create index idx_document_upload_events_org_hash on public.document_upload_events using btree (organization_id, sha256);

create policy "bob_full_read" on "public"."document_upload_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "document_upload_events_select" on "public"."document_upload_events"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) or public.is_grand_master()));

create policy "document_upload_events_write" on "public"."document_upload_events"
  for all
  to PUBLIC
  using ((((organization_id is not null) AND public.is_admin_for_org(organization_id)) or public.is_grand_master()))
  with check ((((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)) OR public.is_grand_master()));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."document_upload_events" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."document_upload_events" is 'Provenance ledger: one row per upload/attach event, ALWAYS recorded even when the bytes already exist (was_deduplicated=true). Separate from the canonical documents row so dedupe never loses who/where/when.';
