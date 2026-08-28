create table "public"."patrol_route_checkpoints" (
  "id"                              uuid                     not null default gen_random_uuid(),
  "patrol_route_id"                 uuid                     not null,
  "name"                            text                     not null,
  "description"                     text,
  "gps_lat"                         double precision,
  "gps_lng"                         double precision,
  "geofence_radius_meters"          integer                  not null default 50,
  "sequence_order"                  integer                  not null default 0,
  "scan_type"                       text                     not null default 'gps'::text,
  "qr_code_data"                    text,
  "expected_arrival_offset_minutes" integer,
  "required_actions"                jsonb                    not null default '[]'::jsonb,
  "is_mandatory"                    boolean                  not null default true,
  "is_active"                       boolean                  not null default true,
  "created_at"                      timestamp with time zone not null default now(),
  constraint "patrol_route_checkpoints_pkey" primary key (id),
  constraint "patrol_route_checkpoints_scan_type_check" check ((scan_type = ANY (ARRAY['gps'::text, 'nfc'::text, 'qr'::text, 'manual'::text]))),
  constraint "patrol_route_checkpoints_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id) on delete cascade
);

alter table "public"."patrol_route_checkpoints"
  enable row level security;

create policy "bob_full_read" on "public"."patrol_route_checkpoints"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "patrol_route_checkpoints_select" on "public"."patrol_route_checkpoints"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.patrol_routes r
  where ((r.id = patrol_route_checkpoints.patrol_route_id) AND public.org_access_allowed(r.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_route_checkpoints" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."patrol_route_checkpoints" is 'Checkpoint sequences within a named patrol route. GPS, NFC, QR, or manual scan types.';
