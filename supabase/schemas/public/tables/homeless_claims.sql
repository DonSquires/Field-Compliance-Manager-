create table "public"."homeless_claims" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "plate_number"          text                     not null,
  "observation_id"        uuid,
  "claimed_at"            timestamp with time zone not null default now(),
  "claimed_by_officer_id" uuid                     not null,
  "claim_basis"           text,
  "status"                text                     not null default 'pending_review'::text,
  "reviewed_by"           uuid,
  "reviewed_at"           timestamp with time zone,
  "review_notes"          text,
  "support_agency"        text,
  "support_contact"       text,
  "referral_notes"        text,
  "evidence_refs"         jsonb,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  constraint "homeless_claims_pkey" primary key (id),
  constraint "homeless_claims_status_check" check ((status = ANY (ARRAY['pending_review'::text, 'confirmed_homeless'::text, 'declined'::text]))),
  constraint "homeless_claims_observation_id_fkey" foreign key (observation_id) references public.observations(id),
  constraint "homeless_claims_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "homeless_claims_claimed_by_officer_id_fkey" foreign key (claimed_by_officer_id) references public.user_profiles(id),
  constraint "homeless_claims_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id)
);

alter table "public"."homeless_claims"
  enable row level security;

create index idx_homeless_claims_org_status on public.homeless_claims using btree (organization_id, status, claimed_at desc);

create index idx_homeless_claims_plate on public.homeless_claims using btree (plate_number, claimed_at desc);

create policy "bob_full_read" on "public"."homeless_claims"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "homeless_claims_insert" on "public"."homeless_claims"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "homeless_claims_select" on "public"."homeless_claims"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "homeless_claims_update" on "public"."homeless_claims"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."homeless_claims" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."homeless_claims" is 'Mandatory verification workflow for a homelessness claim made at point of contact. status=pending_review holds enforcement (does not silently waive it) until an admin/welfare-authorised reviewer confirms or declines -- both outcomes are permanent on the record. Confirming does NOT change the compliance verdict; it sets observations.enforcement_exempt separately (see section 4) so the true rule outcome is never falsified. support_agency/contact model a REFERRAL (LGA 2002 s.11A wellbeing coordination), not a housing commitment -- councils do not carry a statutory duty to house (MSD/HUD do). #73/#74.';
