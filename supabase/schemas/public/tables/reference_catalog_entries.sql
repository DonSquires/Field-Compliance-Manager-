create table "public"."reference_catalog_entries" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "document_version_id" uuid                     not null,
  "organization_id"     uuid,
  "title"               text                     not null,
  "topic"               text,
  "publisher"           text,
  "jurisdiction"        text,
  "document_type"       text,
  "trust_level"         text                     not null default 'unverified'::text,
  "searchable_tags"     text[]                   not null default '{}'::text[],
  "is_global_reference" boolean                  not null default false,
  "approval_status"     text                     not null default 'pending'::text,
  "approved_by"         uuid,
  "approved_at"         timestamp with time zone,
  "created_at"          timestamp with time zone not null default now(),
  "updated_at"          timestamp with time zone not null default now(),
  constraint "reference_catalog_entries_approval_status_check" check ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'revoked'::text]))),
  constraint "reference_catalog_entries_document_version_id_fkey" foreign key (document_version_id) references public.document_versions(id) on delete cascade,
  constraint "reference_catalog_entries_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "reference_catalog_entries_pkey" primary key (id),
  constraint "reference_catalog_entries_trust_level_check" check ((trust_level = ANY (ARRAY['unverified'::text, 'provisional'::text, 'trusted'::text, 'authoritative'::text]))),
  constraint "reference_catalog_entries_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id)
);

alter table "public"."reference_catalog_entries"
  enable row level security;

create index idx_reference_catalog_global on public.reference_catalog_entries using btree (is_global_reference, approval_status)
  where is_global_reference;

create index idx_reference_catalog_org on public.reference_catalog_entries using btree (organization_id, approval_status);

create index idx_reference_catalog_tags on public.reference_catalog_entries using gin (searchable_tags);

create trigger trg_reference_catalog_touch
  before update on public.reference_catalog_entries
  for each row
  execute function public.bob_documents_touch_updated_at();

create policy "bob_full_read" on "public"."reference_catalog_entries"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "reference_catalog_select" on "public"."reference_catalog_entries"
  for select
  to PUBLIC
  using (((is_global_reference AND (approval_status = 'approved'::text)) or public.org_access_allowed(organization_id)));

create policy "reference_catalog_write" on "public"."reference_catalog_entries"
  for all
  to PUBLIC
  using ((((organization_id is not null) AND public.is_admin_for_org(organization_id)) or public.is_grand_master()))
  with check ((((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)) OR public.is_grand_master()));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."reference_catalog_entries" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."reference_catalog_entries" is 'Searchable catalogue entry for an approved / proposed reference document. is_global_reference + approval_status=approved is the only combination Bob may retrieve as a durable global source; setting it is a governed action (promote_document_to_reference_library).';
