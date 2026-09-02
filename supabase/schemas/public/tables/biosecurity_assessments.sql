create table "public"."biosecurity_assessments" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "dispatch_job_id"        uuid,
  "officer_user_id"        uuid,
  "location_id"            uuid,
  "species_identified"     text,
  "density_estimate"       text,
  "seed_head_present"      boolean,
  "bob_species_confirmed"  boolean,
  "bob_checklist"          jsonb                    not null default '{}'::jsonb,
  "bob_recommendation"     text,
  "action_taken"           text,
  "land_use_context"       text,
  "scene_description"      text,
  "assessed_at"            timestamp with time zone not null default now(),
  "created_at"             timestamp with time zone not null default now(),
  "officer_id"             uuid,
  "officer_name"           text,
  "site_id"                uuid,
  "species_name"           text,
  "species_confirmed"      boolean                  not null default false,
  "photo_url"              text,
  "bob_species_id"         text,
  "bob_confidence"         real,
  "action"                 text,
  "notice_number"          text,
  "mpi_referral_number"    text,
  "follow_up_required"     boolean                  not null default false,
  "status"                 text                     not null default 'open'::text,
  "notes"                  text,
  "photo_urls"             jsonb                    default '[]'::jsonb,
  "location_name"          text,
  "protected_land_address" text,
  "protected_land_site_id" uuid,
  "review_status"          text                     not null default 'awaiting_review',
  "review_version"         integer                  not null default 1,
  "review_priority"        text                     not null default 'routine',
  "assigned_reviewer_id"   uuid,
  "review_due_at"          timestamp with time zone,
  "species_review_decision" text                    not null default 'pending',
  "confirmed_species_name" text,
  "reviewed_by"            uuid,
  "reviewed_at"            timestamp with time zone,
  "review_notes"           text,
  constraint "biosecurity_assessments_action_taken_check"
    check ((action_taken = ANY (ARRAY['no_action'::text, 'advisory_notice'::text, 'notice_of_direction'::text, 'infringement_notice'::text, 'mpi_referral'::text]))),
  constraint "biosecurity_assessments_density_estimate_check"
    check ((density_estimate = ANY (ARRAY['isolated'::text, 'scattered'::text, 'moderate'::text, 'dense'::text, 'severe'::text, 'not_found'::text]))),
  constraint "biosecurity_assessments_review_status_check" check (review_status in ('awaiting_review', 'triaged', 'follow_up', 'closed')),
  constraint "biosecurity_assessments_review_priority_check" check (review_priority in ('urgent', 'high', 'routine', 'monitor')),
  constraint "biosecurity_assessments_species_review_decision_check" check (species_review_decision in ('pending', 'confirmed', 'rejected', 'insufficient_evidence')),
  constraint "biosecurity_assessments_review_version_check" check (review_version > 0),
  constraint "biosecurity_assessments_pkey" primary key (id),
  constraint "biosecurity_assessments_protected_land_site_id_fkey" foreign key (protected_land_site_id) references public.client_sites(id) on delete set null,
  constraint "biosecurity_assessments_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "biosecurity_assessments_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id),
  constraint "biosecurity_assessments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "biosecurity_assessments_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id) on delete set null,
  constraint "biosecurity_assessments_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "biosecurity_assessments_assigned_reviewer_id_fkey" foreign key (assigned_reviewer_id) references public.user_profiles(id) on delete set null,
  constraint "biosecurity_assessments_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id) on delete set null
);

alter table "public"."biosecurity_assessments"
  enable row level security;

create index idx_ba_org_status on public.biosecurity_assessments using btree (organization_id, status);

create index idx_biosecurity_review_queue on public.biosecurity_assessments using btree (organization_id, review_status, review_priority, review_due_at, assessed_at desc);

create index idx_ba_protected_land_address on public.biosecurity_assessments using btree (organization_id, protected_land_address)
  where (protected_land_address is not null);

create index idx_ba_protected_land_site_id on public.biosecurity_assessments using btree (protected_land_site_id)
  where (protected_land_site_id is not null);

create index idx_biosecurity_assessments_has_photos on public.biosecurity_assessments using btree (((jsonb_array_length(photo_urls) > 0)));

create policy "ba_insert" on "public"."biosecurity_assessments"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "ba_select" on "public"."biosecurity_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ba_task_entitlement_select" on "public"."biosecurity_assessments"
  for select
  to "authenticated"
  using (public.user_has_task_entitlement(auth.uid(), p_biosecurity_assessment_id => id));

create policy "ba_update" on "public"."biosecurity_assessments"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "biosecurity_assessments_select" on "public"."biosecurity_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."biosecurity_assessments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant insert, references, select, trigger on table "public"."biosecurity_assessments" to "anon", "authenticated";
grant all on table "public"."biosecurity_assessments" to "postgres", "service_role";

comment on column "public"."biosecurity_assessments"."location_name" is 'Free-text location/site name entered by the officer. Added in 0236 — the BiosecurityPage UI was built against this column but it never existed live (same drift class as photo_urls/0033). Mirrors parking_chalk_records.location_name.';

comment on column "public"."biosecurity_assessments"."photo_urls" is 'Array of photo storage paths with metadata: [{"id": "...", "name": "...", "storage_path": "...", "uploaded_at": "...", "metadata": {"gps_latitude": 0, "gps_longitude": 0, "gps_accuracy": 0, "address": "...", "zone": "...", "officer_id": "...", "officer_name": "..."}}]';

comment on column "public"."biosecurity_assessments"."protected_land_address" is 'The threatened/protected land''s address -- the place whose biosecurity condition is threatened by the pest. DISTINCT from the observed source place columns (site_id, location_id, location_name = where the organism/risk was observed). May equal the source place, differ from it, or be unknown-yet (NULL is a legitimate state, not a defect). Named protected_land_* (not complainant_*) because the accountability anchor in biosecurity is the land itself, not a reporting channel. Mirrors the harmed-party anchor pattern of noise 0238 and smoke 0335 but named for protected land because biosecurity harm is a place, not a person. Write-contract slice 2.';

comment on column "public"."biosecurity_assessments"."protected_land_site_id" is 'Optional FK to client_sites for the threatened/protected land -- the site whose biosecurity condition is threatened by the pest. DISTINCT from site_id (the observed SOURCE place where the organism/risk was found). The two may be the same site, different sites, or this anchor may be unknown-yet (NULL is a legitimate state, not a defect). Named protected_land_* (not complainant_*) because the accountability anchor in biosecurity is the land itself, not a reporting channel. Mirrors the harmed-party anchor pattern of noise 0238 (complainant_site_id) and smoke 0335 (complainant_site_id) but named for protected land because biosecurity harm is a place, not a person. Write-contract slice 2.';

comment on policy "ba_task_entitlement_select" on "public"."biosecurity_assessments" is 'ACCESS_MODEL.md keystone composition (same as observations 0325 / noise 0368 / smoke 0369). Additive PERMISSIVE SELECT: a reader sees a biosecurity assessment when they hold a LIVE TASK BASIS on it (0324 user_has_task_entitlement, SECURITY DEFINER via 0326). ORs with the preserved org path (biosecurity_assessments_select); never replaces it. Writes untouched. Read anchor is the live task basis, not a raw address -- protected_land_site_id/protected_land_address (0336) remain the W2 record-side anchor. Fail-direction: under-reach. Operationally corrected / Doctrinally incomplete.';

comment on table "public"."biosecurity_assessments" is 'Biosecurity assessments. Species ID (Bob AI + photo), density, advisory/direction notices, MPI referral.';
