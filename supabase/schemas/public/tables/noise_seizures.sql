create table "public"."noise_seizures" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "noise_assessment_id" uuid                     not null,
  "notice_id"           uuid,
  "item_description"    text                     not null,
  "make"                text,
  "model"               text,
  "serial_number"       text,
  "evidence_id"         uuid,
  "storage_location"    text,
  "seized_at"           timestamp with time zone not null default now(),
  "returned_at"         timestamp with time zone,
  "police_present"      boolean                  not null default false,
  "police_name"         text,
  "photo_urls"          jsonb                    default '[]'::jsonb,
  "seizure_form_number" text,
  "legal_authority"     text                     default 'RMA 1991 s.327'::text,
  constraint "noise_seizures_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id),
  constraint "noise_seizures_noise_assessment_id_fkey" foreign key (noise_assessment_id) references public.noise_assessments(id),
  constraint "noise_seizures_pkey" primary key (id),
  constraint "noise_seizures_notice_id_fkey" foreign key (notice_id) references public.notices(id),
  constraint "noise_seizures_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."noise_seizures"
  enable row level security;

create index idx_noise_seizures_noise_assessment_id on public.noise_seizures using btree (noise_assessment_id);

create index idx_ns_assessment on public.noise_seizures using btree (noise_assessment_id);

create index idx_ns_org on public.noise_seizures using btree (organization_id);

create policy "bob_full_read" on "public"."noise_seizures"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "noise_seizures_select" on "public"."noise_seizures"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ns_insert" on "public"."noise_seizures"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.noise_assessments na
  WHERE ((na.id = noise_seizures.noise_assessment_id) AND public.org_access_allowed(na.organization_id)))));

create policy "ns_parent_reachable_select" on "public"."noise_seizures"
  for select
  to "authenticated"
  using ((exists ( select 1
   from public.noise_assessments na
  where (na.id = noise_seizures.noise_assessment_id))));

create policy "ns_select" on "public"."noise_seizures"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.noise_assessments na
  where ((na.id = noise_seizures.noise_assessment_id) AND public.org_access_allowed(na.organization_id)))));

create policy "ns_update" on "public"."noise_seizures"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.noise_assessments na
  where ((na.id = noise_seizures.noise_assessment_id) AND public.org_access_allowed(na.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."noise_seizures" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."noise_seizures"."legal_authority" is 'Legislative authority for seizure. Default: RMA 1991 s.327.';

comment on column "public"."noise_seizures"."police_present" is 'Police must be present for any equipment seizure or property entry. Mandatory.';

comment on policy "ns_parent_reachable_select" on "public"."noise_seizures" is 'W1 read anchored to PARENT REACHABILITY (single source of truth). Additive PERMISSIVE SELECT: a reader sees a noise seizure IFF they can read its PARENT noise_assessment -- via EXISTS(select 1 from noise_assessments na where na.id = noise_seizures.noise_assessment_id), which re-applies the parent''s OWN composed RLS (org OR task OR future) under the invoker (proven by 0326). NOT a re-expression of the parent''s task limb -- no drift, no widening. ORs with the preserved org path (noise_seizures_select). Writes untouched (W1 read-only). noise_assessment_id NOT NULL -> fail-closed on broken linkage. INTENTIONAL COUPLING (blast radius, by design): this policy inherits EVERY future change to noise_assessments read -- widening OR tightening. That is the point (parent is the single source of truth). A future editor who broadens the parent read broadens seizures too, BY INTENT; do NOT "fix" that by copying a parent limb back into this child (that reintroduces the drift this replaced). Operationally corrected / Doctrinally incomplete.';

comment on table "public"."noise_seizures" is 'Equipment seized under noise Enforcement Notices (RMA s.327). Requires police presence. Each item individually recorded with photo evidence and seizure form number.';
