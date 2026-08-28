create table "public"."patrol_checkpoint_visits" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "organization_id"              uuid                     not null,
  "patrol_id"                    uuid                     not null,
  "checkpoint_id"                uuid                     not null,
  "officer_user_id"              uuid,
  "gps_lat"                      double precision,
  "gps_lng"                      double precision,
  "visited_at"                   timestamp with time zone not null default now(),
  "scan_method"                  text                     not null default 'url_deep_link'::text,
  "gps_accuracy"                 double precision,
  "gps_distance_from_checkpoint" double precision,
  "within_radius"                boolean,
  "notes"                        text,
  "shift_stop_id"                uuid,
  constraint "patrol_checkpoint_visits_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "patrol_checkpoint_visits_pkey" primary key (id),
  constraint "patrol_checkpoint_visits_scan_method_check" check ((scan_method = ANY (ARRAY['qr_camera'::text, 'nfc'::text, 'manual_code'::text, 'url_deep_link'::text]))),
  constraint "patrol_checkpoint_visits_checkpoint_id_fkey" foreign key (checkpoint_id) references public.patrol_checkpoints(id),
  constraint "patrol_checkpoint_visits_patrol_id_fkey" foreign key (patrol_id) references public.patrols(id),
  constraint "patrol_checkpoint_visits_shift_stop_id_fkey" foreign key (shift_stop_id) references public.shift_stops(id) on delete set null,
  constraint "patrol_checkpoint_visits_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."patrol_checkpoint_visits"
  enable row level security;

create index idx_pcv_shift_stop_id on public.patrol_checkpoint_visits using btree (shift_stop_id)
  where (shift_stop_id is not null);

create policy "bob_full_read" on "public"."patrol_checkpoint_visits"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "patrol_checkpoint_visits_insert" on "public"."patrol_checkpoint_visits"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "patrol_checkpoint_visits_select" on "public"."patrol_checkpoint_visits"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_checkpoint_visits" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."patrol_checkpoint_visits"."gps_distance_from_checkpoint" is 'Haversine metres between the officer GPS fix and the checkpoint at scan time.';

comment on column "public"."patrol_checkpoint_visits"."scan_method" is 'How the visit was captured: qr_camera | nfc | manual_code | url_deep_link.';

comment on column "public"."patrol_checkpoint_visits"."shift_stop_id" is 'The engine shift_stop this checkpoint visit fulfils, when resolvable. Null when no unambiguous stop matches (the checkpoint->site mapping is resolved by P5). Enables per-stop completion + missed-checkpoint detection.';

comment on column "public"."patrol_checkpoint_visits"."within_radius" is 'Whether the officer was within the expected check-in radius at scan time.';

comment on table "public"."patrol_checkpoint_visits" is 'Officer QR scan events at patrol checkpoints. Proves attendance and timing.';
