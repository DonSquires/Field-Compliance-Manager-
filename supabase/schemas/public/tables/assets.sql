create table "public"."assets" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "asset_type"           text                     not null,
  "name"                 text                     not null,
  "serial_number"        text,
  "registration"         text,
  "make"                 text,
  "model"                text,
  "year"                 integer,
  "assigned_to"          uuid,
  "assigned_site_id"     uuid,
  "status"               text                     not null default 'available'::text,
  "last_inspection_date" date,
  "next_inspection_date" date,
  "notes"                text,
  "created_at"           timestamp with time zone not null default now(),
  constraint "assets_asset_type_check"
    check
    ((asset_type = ANY (ARRAY['vehicle'::text, 'radio'::text, 'body_camera'::text, 'torch'::text, 'uniform'::text, 'first_aid_kit'::text, 'ems_device'::text, 'other'::text]))),
  constraint "assets_pkey" primary key (id),
  constraint "assets_status_check" check ((status = ANY (ARRAY['available'::text, 'in_use'::text, 'maintenance'::text, 'retired'::text, 'lost'::text]))),
  constraint "assets_assigned_site_id_fkey" foreign key (assigned_site_id) references public.client_sites(id),
  constraint "assets_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "assets_assigned_to_fkey" foreign key (assigned_to) references public.user_profiles(id)
);

alter table "public"."assets"
  enable row level security;

create policy "assets_insert" on "public"."assets"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "assets_select" on "public"."assets"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "assets_update" on "public"."assets"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

create policy "bob_full_read" on "public"."assets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."assets"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."assets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."assets" is 'Fleet and equipment management. Vehicles, radios, cameras, EMS devices, and other assets.';
