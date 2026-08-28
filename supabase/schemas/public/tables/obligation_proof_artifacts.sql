create table "public"."obligation_proof_artifacts" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "obligation_id"    uuid                     not null,
  "artifact_type"    text                     not null,
  "source_table"     text,
  "source_record_id" uuid,
  "captured_at"      timestamp with time zone not null default now(),
  "notes"            text,
  "created_by"       uuid,
  "created_at"       timestamp with time zone not null default now(),
  constraint "obligation_proof_artifacts_artifact_type_check"
    check
    ((artifact_type = ANY (ARRAY['patrol_log'::text, 'checkpoint_visit'::text, 'dispatch_event'::text, 'arrival_timestamp'::text, 'incident_report'::text, 'photo'::text,
    'gps_track'::text, 'report'::text, 'signature'::text, 'other'::text]))),
  constraint "obligation_proof_artifacts_obligation_id_fkey" foreign key (obligation_id) references public.agreement_obligations(id) on delete cascade,
  constraint "obligation_proof_artifacts_pkey" primary key (id),
  constraint "obligation_proof_artifacts_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "obligation_proof_artifacts_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."obligation_proof_artifacts"
  enable row level security;

create index idx_opa_obligation on public.obligation_proof_artifacts using btree (obligation_id, captured_at desc);

create index idx_opa_org on public.obligation_proof_artifacts using btree (organization_id, captured_at desc);

create policy "bob_full_read" on "public"."obligation_proof_artifacts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "obligation_proof_artifacts_insert" on "public"."obligation_proof_artifacts"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "obligation_proof_artifacts_select" on "public"."obligation_proof_artifacts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "obligation_proof_artifacts_update" on "public"."obligation_proof_artifacts"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."obligation_proof_artifacts" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."obligation_proof_artifacts" is 'Links proof records (patrol log, checkpoint visit, dispatch event, incident, photo, etc.) to a contract obligation for proof-artifact completeness tracking.';
