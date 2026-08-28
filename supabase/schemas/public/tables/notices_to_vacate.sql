create table "public"."notices_to_vacate" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "observation_id"      uuid,
  "breach_alert_id"     uuid,
  "zone_id"             uuid,
  "plate_number"        text                     not null,
  "vacate_by"           timestamp with time zone,
  "reason"              text,
  "authorising_act"     text                     not null default 'Freedom Camping Act 2011'::text,
  "authorising_section" text                     not null default 's.16'::text,
  "issued_by"           uuid                     not null,
  "issued_at"           timestamp with time zone not null default now(),
  "pdf_url"             text,
  "pdf_generated_at"    timestamp with time zone,
  "status"              text                     not null default 'issued'::text,
  "created_at"          timestamp with time zone not null default now(),
  constraint "notices_to_vacate_breach_alert_id_fkey" foreign key (breach_alert_id) references public.breach_alerts(id),
  constraint "notices_to_vacate_pkey" primary key (id),
  constraint "notices_to_vacate_status_check" check ((status = ANY (ARRAY['issued'::text, 'complied'::text, 'escalated'::text, 'withdrawn'::text]))),
  constraint "notices_to_vacate_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "notices_to_vacate_observation_id_fkey" foreign key (observation_id) references public.observations(id),
  constraint "notices_to_vacate_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "notices_to_vacate_issued_by_fkey" foreign key (issued_by) references public.user_profiles(id)
);

alter table "public"."notices_to_vacate"
  enable row level security;

create index idx_notices_to_vacate_org on public.notices_to_vacate using btree (organization_id, issued_at desc);

create index idx_notices_to_vacate_plate on public.notices_to_vacate using btree (plate_number, issued_at desc);

create policy "bob_full_read" on "public"."notices_to_vacate"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "notices_to_vacate_insert" on "public"."notices_to_vacate"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "notices_to_vacate_select" on "public"."notices_to_vacate"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "notices_to_vacate_update" on "public"."notices_to_vacate"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."notices_to_vacate" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."notices_to_vacate" is 'Issued Notice to Vacate documents. Step 3 in the enforcement ladder.';
