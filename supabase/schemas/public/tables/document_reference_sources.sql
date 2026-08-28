create table "public"."document_reference_sources" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "label"               text                     not null,
  "source_kind"         text                     not null default 'repo_folder'::text,
  "location_ref"        text                     not null,
  "organization_id"     uuid,
  "trust_level"         text                     not null default 'provisional'::text,
  "default_scope"       text                     not null default 'tenant_reference'::text,
  "default_sensitivity" text                     not null default 'tenant_sensitive'::text,
  "approval_status"     text                     not null default 'pending'::text,
  "is_active"           boolean                  not null default true,
  "notes"               text,
  "created_at"          timestamp with time zone not null default now(),
  "updated_at"          timestamp with time zone not null default now(),
  constraint "document_reference_sources_approval_status_check" check ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'revoked'::text]))),
  constraint "document_reference_sources_default_scope_check" check ((default_scope = ANY (ARRAY['conversation_only'::text, 'tenant_reference'::text, 'global_reference'::text]))),
  constraint "document_reference_sources_default_sensitivity_check"
    check ((default_sensitivity = ANY (ARRAY['public'::text, 'internal_non_sensitive'::text, 'tenant_sensitive'::text, 'restricted'::text]))),
  constraint "document_reference_sources_pkey" primary key (id),
  constraint "document_reference_sources_source_kind_check" check ((source_kind = ANY (ARRAY['repo_folder'::text, 'storage_prefix'::text, 'external_url'::text]))),
  constraint "document_reference_sources_trust_level_check" check ((trust_level = ANY (ARRAY['unverified'::text, 'provisional'::text, 'trusted'::text, 'authoritative'::text]))),
  constraint "document_reference_sources_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."document_reference_sources"
  enable row level security;

create index idx_document_reference_sources_org on public.document_reference_sources using btree (organization_id, is_active);

create unique index uq_document_reference_sources_kind_loc_org on public.document_reference_sources
  using btree (source_kind, location_ref, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

create trigger trg_document_reference_sources_touch
  before update on public.document_reference_sources
  for each row
  execute function public.bob_documents_touch_updated_at();

create policy "bob_full_read" on "public"."document_reference_sources"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "document_reference_sources_select" on "public"."document_reference_sources"
  for select
  to PUBLIC
  using ((((organization_id is null) AND (approval_status = 'approved'::text)) or public.org_access_allowed(organization_id)));

create policy "document_reference_sources_write" on "public"."document_reference_sources"
  for all
  to PUBLIC
  using ((((organization_id is not null) AND public.is_admin_for_org(organization_id)) or public.is_grand_master()))
  with check ((((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)) OR public.is_grand_master()));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."document_reference_sources" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."document_reference_sources" is 'Registry of source-location roots Bob may draw reference material from. Registering a location does NOT ingest or promote content; it sets the default scope/sensitivity that applies until a document is individually classified and (if ever) promoted via the governed flow. Tenant sources stay org-scoped.';
