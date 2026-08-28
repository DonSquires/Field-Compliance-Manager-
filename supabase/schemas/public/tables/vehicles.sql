create table "public"."vehicles" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "plate"             text                     not null,
  "make"              text,
  "model"             text,
  "colour"            text,
  "year"              integer,
  "make_confidence"   real,
  "model_confidence"  real,
  "colour_confidence" real,
  "scv_status"        text,
  "scv_expiry"        date,
  "scv_checked_at"    timestamp with time zone,
  "is_flagged"        boolean                  not null default false,
  "flag_reason"       text,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  constraint "vehicles_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "vehicles_organization_id_plate_key" unique (organization_id, plate),
  constraint "vehicles_pkey" primary key (id),
  constraint "vehicles_scv_status_check" check ((scv_status = ANY (ARRAY['certified'::text, 'expired'::text, 'not_found'::text, 'unknown'::text, 'exempt'::text, 'pending'::text])))
);

alter table "public"."vehicles"
  enable row level security;

create policy "bob_full_read" on "public"."vehicles"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "vehicles_insert" on "public"."vehicles"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "vehicles_select" on "public"."vehicles"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "vehicles_update" on "public"."vehicles"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."vehicles" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."vehicles" is 'Canonical vehicle registry. One row per unique plate per org. Shared across all modules.';
