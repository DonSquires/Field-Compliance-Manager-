create table "public"."breach_alerts" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "observation_id"       uuid,
  "zone_id"              uuid,
  "plate_number"         text                     not null,
  "breach_type"          text                     not null default 'nightly_limit'::text,
  "nights_count"         integer,
  "limit_value"          integer,
  "status"               text                     not null default 'open'::text,
  "actioned_by"          uuid,
  "actioned_at"          timestamp with time zone,
  "action_type"          text,
  "notes"                text,
  "created_at"           timestamp with time zone not null default now(),
  "overnight_session_id" uuid,
  "client_org_id"        uuid,
  constraint "breach_alerts_action_type_check"
    check
    ((action_type = ANY (ARRAY['verbal_warning'::text, 'written_warning'::text, 'notice_to_vacate'::text, 'infringement'::text, 'tow_request'::text, 'welfare_referral'::text,
    'dismissed'::text]))),
  constraint "breach_alerts_breach_type_check"
    check
    ((breach_type = ANY (ARRAY['nightly_limit'::text, 'monthly_limit'::text, 'no_scv'::text, 'prohibited_area'::text, 'time_restriction'::text, 'vehicle_type'::text,
    'trespass'::text,
    'other'::text, 'no_overnight_permitted'::text, 'parking_overstay'::text, 'parking_repeat_overstay'::text, 'expired_rego'::text, 'expired_wof'::text, 'expired_cof'::text]))),
  constraint "breach_alerts_pkey" primary key (id),
  constraint "breach_alerts_status_check"
    check ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'actioned'::text, 'dismissed'::text, 'resolved'::text, 'exempt_homeless'::text]))),
  constraint "breach_alerts_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "breach_alerts_observation_id_fkey" foreign key (observation_id) references public.observations(id),
  constraint "breach_alerts_client_org_id_fkey" foreign key (client_org_id) references public.organizations(id),
  constraint "breach_alerts_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "breach_alerts_actioned_by_fkey" foreign key (actioned_by) references public.user_profiles(id)
);

alter table "public"."breach_alerts"
  enable row level security;

create index idx_breach_alerts_client_org_id on public.breach_alerts using btree (client_org_id);

create index idx_breach_alerts_org_status on public.breach_alerts using btree (organization_id, status, created_at desc);

create unique index idx_breach_alerts_parking_dedup on public.breach_alerts using btree (organization_id, plate_number, zone_id, breach_type)
  where (status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'actioned'::text]));

create index idx_breach_alerts_plate on public.breach_alerts using btree (plate_number, created_at desc);

create unique index idx_breach_alerts_session_active_unique on public.breach_alerts using btree (overnight_session_id)
  where ((overnight_session_id is not null) AND (status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'actioned'::text, 'exempt_homeless'::text])));

create index idx_breach_alerts_session on public.breach_alerts using btree (overnight_session_id)
  where (overnight_session_id is not null);

create index idx_breach_alerts_zone on public.breach_alerts using btree (zone_id, status);

create policy "bob_full_read" on "public"."breach_alerts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "breach_alerts_client_org_select" on "public"."breach_alerts"
  for select
  to PUBLIC
  using (public.org_access_allowed(client_org_id));

create policy "breach_alerts_insert" on "public"."breach_alerts"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "breach_alerts_select" on "public"."breach_alerts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "breach_alerts_update" on "public"."breach_alerts"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."breach_alerts" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."breach_alerts"."breach_type" is 'Breach category. Values: nightly_limit, monthly_limit, no_scv, prohibited_area, time_restriction, vehicle_type, trespass, other, no_overnight_permitted (0191), parking_overstay, parking_repeat_overstay (0227), expired_rego, expired_wof, expired_cof (0228).';

comment on column "public"."breach_alerts"."observation_id" is 'FK to observations. Nullable: the process-officer-scan path populates this; the FCOvernightVerificationPage manual-escalation path does not (it keys to overnight_session_id instead). #76.';

comment on column "public"."breach_alerts"."overnight_session_id" is 'FK to vehicle_overnight_sessions. Used as the structural dedup key: at most one active breach per verified overnight session (partial unique index on status in open/acknowledged/actioned/exempt_homeless). Nullable for non-overnight breach types. #76.';

comment on column "public"."breach_alerts"."status" is 'open|acknowledged|actioned|dismissed|resolved = normal enforcement lifecycle. exempt_homeless = breach is real (non-compliant) but enforcement is suppressed pending/following a confirmed homeless_claims record; excluded from actionable NTV/infringement queues, included in the homeless-exempt KPI tile if a council enables it. #74.';

comment on index "public"."idx_breach_alerts_parking_dedup" is 'Dedup guard for parking breach alerts: at most one active (open/acknowledged/actioned) breach per org+plate+zone+type. Prevents cross-zone dedup collisions and TOCTOU races. 0233 CC3 QA fix. Mirrors 0196 pattern.';

comment on table "public"."breach_alerts" is 'Unresolved compliance breaches. Created on non-compliant scan. Resolved by admin action.';
