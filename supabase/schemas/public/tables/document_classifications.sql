create table "public"."document_classifications" (
  "id"                            uuid                     not null default gen_random_uuid(),
  "document_version_id"           uuid                     not null,
  "privacy_class"                 text                     not null,
  "contains_pii"                  boolean                  not null default false,
  "contains_operational_security" boolean                  not null default false,
  "contains_financial_data"       boolean                  not null default false,
  "contains_legal_privilege"      boolean                  not null default false,
  "classifier_source"             text                     not null default 'bob'::text,
  "confidence"                    real,
  "rationale"                     text,
  "reviewed_by"                   uuid,
  "reviewed_at"                   timestamp with time zone,
  "created_at"                    timestamp with time zone not null default now(),
  constraint "document_classifications_classifier_source_check" check ((classifier_source = ANY (ARRAY['bob'::text, 'human_review'::text, 'rule_engine'::text]))),
  constraint "document_classifications_confidence_check" check (((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))),
  constraint "document_classifications_pkey" primary key (id),
  constraint "document_classifications_privacy_class_check"
    check ((privacy_class = ANY (ARRAY['public'::text, 'internal_non_sensitive'::text, 'tenant_sensitive'::text, 'restricted'::text]))),
  constraint "document_classifications_document_version_id_fkey" foreign key (document_version_id) references public.document_versions(id) on delete cascade,
  constraint "document_classifications_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id)
);

alter table "public"."document_classifications"
  enable row level security;

create index idx_document_classifications_version on public.document_classifications using btree (document_version_id, created_at desc);

create policy "bob_full_read" on "public"."document_classifications"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "document_classifications_select" on "public"."document_classifications"
  for select
  to PUBLIC
  using ((exists ( select 1
   from (public.document_versions v
     JOIN public.documents d on ((d.id = v.document_id)))
  where
    ((v.id = document_classifications.document_version_id) AND (((d.organization_id is null) AND (d.current_scope = 'global_reference'::text)) or
    public.org_access_allowed(d.organization_id))))));

create policy "document_classifications_write" on "public"."document_classifications"
  for all
  to PUBLIC
  using ((exists ( select 1
   from (public.document_versions v
     JOIN public.documents d on ((d.id = v.document_id)))
  where ((v.id = document_classifications.document_version_id) AND (((d.organization_id is
    not null) AND public.is_admin_for_org(d.organization_id)) or public.is_grand_master())))))
  with check ((EXISTS ( SELECT 1
   FROM (public.document_versions v
     JOIN public.documents d ON ((d.id = v.document_id)))
  WHERE ((v.id = document_classifications.document_version_id) AND (((d.organization_id IS
    NOT NULL) AND public.is_admin_for_org(d.organization_id)) OR public.is_grand_master())))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."document_classifications" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."document_classifications" is 'Sensitivity classification for a document version. Bob may propose (classifier_source=bob); low-confidence / high-risk classifications require human_review before any promotion to a shared library.';
