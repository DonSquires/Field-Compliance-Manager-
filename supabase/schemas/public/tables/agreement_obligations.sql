create table "public"."agreement_obligations" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "service_agreement_id" uuid                     not null,
  "obligation_type"      text                     not null,
  "description"          text                     not null,
  "sla_target_minutes"   integer,
  "requires_proof"       boolean                  not null default false,
  "proof_artifact_type"  text,
  "escalation_minutes"   integer,
  "escalation_contact"   text,
  "active"               boolean                  not null default true,
  "created_at"           timestamp with time zone not null default now(),
  "obligation_code"      text,
  "site_id"              uuid,
  "frequency_rule"       jsonb,
  constraint "agreement_obligations_obligation_type_check"
    check
    ((obligation_type = ANY (ARRAY['response_time'::text, 'patrol_frequency'::text, 'report_delivery'::text, 'incident_escalation'::text, 'compliance_check'::text,
    'custom'::text]))),
  constraint "agreement_obligations_pkey" primary key (id),
  constraint "agreement_obligations_proof_artifact_type_check"
    check ((proof_artifact_type = ANY (ARRAY['photo'::text, 'gps_track'::text, 'report'::text, 'signature'::text, 'timestamp'::text, 'other'::text]))),
  constraint "agreement_obligations_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "agreement_obligations_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade
);

alter table "public"."agreement_obligations"
  enable row level security;

create index idx_agreement_obligations_agreement on public.agreement_obligations using btree (service_agreement_id);

create index idx_agreement_obligations_site on public.agreement_obligations using btree (site_id)
  where (site_id is not null);

create policy "agreement_obligations_delete" on "public"."agreement_obligations"
  for delete
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where ((s.id = agreement_obligations.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))));

create policy "agreement_obligations_insert" on "public"."agreement_obligations"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.service_agreements s
  WHERE ((s.id = agreement_obligations.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))));

create policy "agreement_obligations_select" on "public"."agreement_obligations"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where ((s.id = agreement_obligations.service_agreement_id) AND (public.org_access_allowed(s.provider_organization_id) or public.org_access_allowed(s.client_organization_id))))));

create policy "agreement_obligations_update" on "public"."agreement_obligations"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where ((s.id = agreement_obligations.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))))
  with check ((EXISTS ( SELECT 1
   FROM public.service_agreements s
  WHERE ((s.id = agreement_obligations.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))));

create policy "bob_full_read" on "public"."agreement_obligations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."agreement_obligations" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."agreement_obligations"."frequency_rule" is 'JSON rule payload for frequency/coverage obligations (per day/week, count, template).';

comment on column "public"."agreement_obligations"."obligation_code" is 'Stable code for the obligation (e.g. NCC schedule reference). Used by report packs.';

comment on column "public"."agreement_obligations"."site_id" is 'Optional facility/site this obligation applies to (facility frequency matrix).';

comment on table "public"."agreement_obligations" is 'Contract rules with SLA targets, proof requirements, and escalation paths.';
