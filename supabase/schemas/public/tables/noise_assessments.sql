create table "public"."noise_assessments" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "organization_id"              uuid                     not null,
  "dispatch_job_id"              uuid,
  "officer_user_id"              uuid,
  "location_id"                  uuid,
  "decibel_reading"              real,
  "noise_source"                 text,
  "prior_notice_count"           integer                  not null default 0,
  "prior_notice_types"           text[],
  "permanent_end_active"         boolean                  not null default false,
  "hs_flag_active"               boolean                  not null default false,
  "hs_notes"                     text,
  "bob_recommendation"           text,
  "action_taken"                 text,
  "scene_description"            text,
  "assessed_at"                  timestamp with time zone not null default now(),
  "created_at"                   timestamp with time zone not null default now(),
  "officer_id"                   uuid,
  "officer_name"                 text,
  "site_id"                      uuid,
  "source"                       text,
  "time_of_day"                  time without time zone,
  "prior_notices"                integer                  not null default 0,
  "action"                       text,
  "notice_number"                text,
  "follow_up_required"           boolean                  not null default false,
  "follow_up_at"                 timestamp with time zone,
  "status"                       text                     not null default 'open'::text,
  "notes"                        text,
  "bob_classification"           text,
  "bob_confidence"               real,
  "volume_score"                 smallint,
  "time_score"                   smallint,
  "tone_score"                   smallint,
  "matrix_total"                 smallint,
  "visit_number_tonight"         integer                  not null default 1,
  "is_problem_address"           boolean                  not null default false,
  "end_number"                   text,
  "occupant_name"                text,
  "prior_end_within_72hrs"       boolean                  not null default false,
  "permanent_abatement_active"   boolean                  not null default false,
  "occupant_cooperative"         boolean,
  "police_requested"             boolean                  not null default false,
  "police_present"               boolean                  not null default false,
  "received_at"                  timestamp with time zone,
  "arrived_at"                   timestamp with time zone,
  "departed_at"                  timestamp with time zone,
  "hs_checklist_completed"       boolean                  not null default false,
  "hs_checklist_items"           jsonb                    default '[]'::jsonb,
  "hs_abort_reason"              text,
  "referred_animal_control"      boolean                  not null default false,
  "incident_report_text"         text,
  "complainant_protected"        boolean                  not null default true,
  "assessment_location"          text,
  "assessment_gps_lat"           double precision,
  "assessment_gps_lng"           double precision,
  "assessment_gps_accuracy"      real,
  "noise_source_address"         text,
  "noise_source_gps_lat"         double precision,
  "noise_source_gps_lng"         double precision,
  "arrival_gps_lat"              double precision,
  "arrival_gps_lng"              double precision,
  "arrival_gps_accuracy"         real,
  "address_discrepancy_noted"    boolean                  not null default false,
  "address_discrepancy_reason"   text,
  "photo_assessment_point"       jsonb                    default '[]'::jsonb,
  "photo_source_address"         jsonb                    default '[]'::jsonb,
  "photo_service_evidence"       jsonb                    default '[]'::jsonb,
  "evidence_package_url"         text,
  "job_number"                   text,
  "occupant_dob"                 date,
  "is_large_event_or_commercial" boolean,
  "supplementary_scores"         jsonb,
  "photo_urls"                   jsonb                    default '[]'::jsonb,
  "complaint_address"            text,
  "complainant_site_id"          uuid,
  "external_refs"                jsonb                    not null default '{}'::jsonb,
  constraint "noise_assessments_action_taken_check"
    check
    ((action_taken = ANY (ARRAY['no_action'::text, 'verbal_warning'::text, 'abatement_notice'::text, 'direction_notice'::text, 'enforcement_notice'::text, 'equipment_seized'::text,
    'prosecution_referral'::text]))),
  constraint "noise_assessments_complainant_site_id_fkey" foreign key (complainant_site_id) references public.client_sites(id) on delete set null,
  constraint "noise_assessments_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id),
  constraint "noise_assessments_pkey" primary key (id),
  constraint "noise_assessments_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "noise_assessments_time_score_check" check (((time_score >= 1) AND (time_score <= 4))),
  constraint "noise_assessments_tone_score_check" check (((tone_score >= 0) AND (tone_score <= 2))),
  constraint "noise_assessments_volume_score_check" check (((volume_score >= 0) AND (volume_score <= 4))),
  constraint "noise_assessments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "noise_assessments_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id) on delete set null,
  constraint "noise_assessments_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."noise_assessments"
  enable row level security;

create index idx_na_complainant_site_id on public.noise_assessments using btree (complainant_site_id)
  where (complainant_site_id is not null);

create index idx_na_complaint_address on public.noise_assessments using btree (organization_id, complaint_address)
  where (complaint_address is not null);

create index idx_na_dispatch_job on public.noise_assessments using btree (dispatch_job_id)
  where (dispatch_job_id is not null);

create index idx_na_noise_source_address on public.noise_assessments using btree (organization_id, noise_source_address)
  where (noise_source_address is not null);

create index idx_na_org_status on public.noise_assessments using btree (organization_id, status);

create index idx_noise_assessments_external_refs on public.noise_assessments using gin (external_refs);

create index idx_noise_assessments_has_photos on public.noise_assessments using btree (((jsonb_array_length(photo_urls) > 0)));

create policy "bob_full_read" on "public"."noise_assessments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "na_insert" on "public"."noise_assessments"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "na_select" on "public"."noise_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "na_task_entitlement_select" on "public"."noise_assessments"
  for select
  to "authenticated"
  using (public.user_has_task_entitlement(auth.uid(), p_noise_assessment_id => id));

create policy "na_update" on "public"."noise_assessments"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "noise_assessments_select" on "public"."noise_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."noise_assessments" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."noise_assessments"."address_discrepancy_noted" is 'True when noise_source_address differs from complaint address. Officer must record reason.';

comment on column "public"."noise_assessments"."arrival_gps_lat" is 'GPS coordinates logged automatically when officer starts the job. Proves officer location.';

comment on column "public"."noise_assessments"."assessment_location" is 'Where the officer stood to conduct the assessment. May differ from complaint address.';

comment on column "public"."noise_assessments"."bob_classification" is 'Bob AI classification result for noise source identification from photo evidence';

comment on column "public"."noise_assessments"."bob_confidence" is 'Bob AI confidence score (0-100) for the classification result';

comment on column "public"."noise_assessments"."complainant_protected" is 'Complainant identity must never be disclosed to the offending address. Always true.';

comment on column "public"."noise_assessments"."complainant_site_id" is 'Optional FK to client_sites for the complainant''s property. Allows linking complaints to known sites for pattern detection (e.g. vexatious complaints from the same address). #159.';

comment on column "public"."noise_assessments"."complaint_address" is 'The complainant''s address (where the complaint originates). Distinct from noise_source_address (the offending property). Searchable. #159.';

comment on column "public"."noise_assessments"."dispatch_job_id" is 'FK to dispatch_jobs when this noise job was created via dispatch integration. Null for standalone jobs.';

comment on column "public"."noise_assessments"."end_number" is 'Excessive Noise Direction number. Required on incident report when END issued.';

comment on column "public"."noise_assessments"."external_refs" is 'Generic external system reference IDs. E.g. {"wilsar": {"dispatch_id": "54011208", "docket": "54011208", "imported_historic": true}}';

comment on column "public"."noise_assessments"."hs_checklist_completed" is 'Officer confirmed H&S pre-visit checklist before attending. Required gate.';

comment on column "public"."noise_assessments"."is_large_event_or_commercial" is 'Whether this assessment is for a large event or commercial premises. Only captured when org config enables it.';

comment on column "public"."noise_assessments"."job_number" is 'Human-readable job number, e.g. NC-2026-001245. Auto-generated on job creation.';

comment on column "public"."noise_assessments"."matrix_total" is 'TDC matrix total: volume+time+tone (time ignored when volume=0). 0=no action, 1-4=acceptable, 5+=excessive.';

comment on column "public"."noise_assessments"."noise_source_address" is 'The actual property producing the noise (text). May differ from complaint_address. The site_id FK anchors to this address. #159.';

comment on column "public"."noise_assessments"."occupant_dob" is 'Date of birth of the person served. Only captured when org config (noise_module_config.require_occupant_dob) is enabled.';

comment on column "public"."noise_assessments"."occupant_name" is 'Name of occupant served with END. Required on incident report.';

comment on column "public"."noise_assessments"."permanent_abatement_active" is 'Permanent Abatement Notice in effect at this address — triggers equipment seizure authority.';

comment on column "public"."noise_assessments"."photo_assessment_point" is 'Mandatory photo(s) showing where officer stood and street context.';

comment on column "public"."noise_assessments"."photo_service_evidence" is 'Photo of notice location or person served (where policy permits).';

comment on column "public"."noise_assessments"."photo_source_address" is 'Mandatory photo(s) of source address letterbox/number before END can be finalised.';

comment on column "public"."noise_assessments"."photo_urls" is 'Array of photo storage paths with metadata: [{"id": "...", "name": "...", "storage_path": "...", "uploaded_at": "...", "metadata": {"gps_latitude": 0, "gps_longitude": 0, "gps_accuracy": 0, "address": "...", "zone": "...", "officer_id": "...", "officer_name": "..."}}]';

comment on column "public"."noise_assessments"."prior_end_within_72hrs" is 'END issued at this address within last 72 hours — triggers equipment seizure authority.';

comment on column "public"."noise_assessments"."site_id" is 'FK to client_sites — anchored to the NOISE SOURCE property (the offending address). Owner rule (#157): repeat-offender counts, problem-address flags, prior-END-within-72hrs all key off this site. Never the complainant''s address.';

comment on column "public"."noise_assessments"."supplementary_scores" is 'Supplementary factor scores for this assessment (e.g. { day_of_week: 2, duration: 1 }). Null when org uses TDC-only.';

comment on column "public"."noise_assessments"."time_score" is 'TDC matrix: 1=7am-9pm, 2=9pm-midnight, 3=midnight-2am, 4=2am-7am. Ignored when volume_score=0.';

comment on column "public"."noise_assessments"."tone_score" is 'TDC matrix: 0=No bass, 1=Slight bass, 2=Heavy bass';

comment on column "public"."noise_assessments"."volume_score" is 'TDC matrix: 0=No Noise, 1=Barely Audible, 2=Clearly Audible, 3=Loud, 4=Extremely Loud';

comment on policy "na_task_entitlement_select" on "public"."noise_assessments" is 'ACCESS_MODEL.md keystone composition (supersedes 0367 place-only gate). Additive PERMISSIVE SELECT: a reader sees a noise assessment when they hold a LIVE TASK BASIS on it (0324 user_has_task_entitlement, SECURITY DEFINER via 0326 -- resolves cross-org dispatch/roster/supervisory signal rows the caller cannot directly see). ORs with the preserved org paths (noise_assessments_select, na_select); never replaces them. Writes untouched. Read anchor is the live task basis, not a raw address -- complainant_site_id/complaint_address remain the W2 record-side harmed-party anchor. Fail-direction: under-reach. Operationally corrected / Doctrinally incomplete.';

comment on table "public"."noise_assessments" is 'Noise control assessments. 6-step workflow: attend, identify, measure, history, action, follow-up.';
