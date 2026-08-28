create table "public"."document_versions" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "document_id"           uuid                     not null,
  "version_label"         text                     not null default 'v1'::text,
  "effective_from"        date,
  "effective_to"          date,
  "supersedes_version_id" uuid,
  "extracted_text"        text,
  "extraction_confidence" real,
  "ocr_required"          boolean                  not null default false,
  "metadata_json"         jsonb                    not null default '{}'::jsonb,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  constraint "document_versions_document_id_version_label_key" unique (document_id, version_label),
  constraint "document_versions_extraction_confidence_check"
    check (((extraction_confidence IS NULL) OR ((extraction_confidence >= (0)::double precision) AND (extraction_confidence <= (1)::double precision)))),
  constraint "document_versions_pkey" primary key (id),
  constraint "document_versions_supersedes_version_id_fkey" foreign key (supersedes_version_id) references public.document_versions(id) on delete set null,
  constraint "document_versions_document_id_fkey" foreign key (document_id) references public.documents(id) on delete cascade
);

alter table "public"."document_versions"
  enable row level security;

create index idx_document_versions_document on public.document_versions using btree (document_id, created_at desc);

create trigger trg_document_versions_touch
  before update on public.document_versions
  for each row
  execute function public.bob_documents_touch_updated_at();

create policy "bob_full_read" on "public"."document_versions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "document_versions_select" on "public"."document_versions"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.documents d
  where
    ((d.id = document_versions.document_id) AND (((d.organization_id is null) AND (d.current_scope = 'global_reference'::text)) or public.org_access_allowed(d.organization_id))))));

create policy "document_versions_write" on "public"."document_versions"
  for all
  to PUBLIC
  using ((exists ( select 1
   from public.documents d
  where ((d.id = document_versions.document_id) AND (((d.organization_id is not null) AND public.is_admin_for_org(d.organization_id)) or public.is_grand_master())))))
  with check ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_versions.document_id) AND (((d.organization_id IS NOT NULL) AND public.is_admin_for_org(d.organization_id)) OR public.is_grand_master())))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."document_versions" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."document_versions" is 'Extracted, readable content for a document version. Text is stored separately from the binary blob. Supports supersession and effective-date windows.';
