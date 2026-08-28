create table "public"."infringement_notices" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "observation_id"      uuid,
  "breach_alert_id"     uuid,
  "zone_id"             uuid,
  "notice_number"       text                     not null,
  "plate_number"        text                     not null,
  "offence_date"        date                     not null,
  "offence_description" text,
  "authorising_act"     text                     not null default 'Freedom Camping Act 2011'::text,
  "authorising_section" text                     not null default 's.20'::text,
  "amount"              numeric(10,2)            not null,
  "due_date"            date                     not null,
  "payment_url"         text,
  "objections_email"    text,
  "objections_address"  text,
  "objections_deadline" date,
  "issued_by"           uuid                     not null,
  "issued_at"           timestamp with time zone not null default now(),
  "pdf_url"             text,
  "pdf_generated_at"    timestamp with time zone,
  "status"              text                     not null default 'issued'::text,
  "created_at"          timestamp with time zone not null default now(),
  constraint "infringement_notices_breach_alert_id_fkey" foreign key (breach_alert_id) references public.breach_alerts(id),
  constraint "infringement_notices_pkey" primary key (id),
  constraint "infringement_notices_status_check" check ((status = ANY (ARRAY['issued'::text, 'paid'::text, 'objected'::text, 'withdrawn'::text, 'court'::text]))),
  constraint "infringement_notices_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "infringement_notices_observation_id_fkey" foreign key (observation_id) references public.observations(id),
  constraint "infringement_notices_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "infringement_notices_issued_by_fkey" foreign key (issued_by) references public.user_profiles(id)
);

alter table "public"."infringement_notices"
  enable row level security;

create index idx_infringement_notices_org on public.infringement_notices using btree (organization_id, issued_at desc);

create index idx_infringement_notices_plate on public.infringement_notices using btree (plate_number, issued_at desc);

create policy "bob_full_read" on "public"."infringement_notices"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "infringement_notices_insert" on "public"."infringement_notices"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "infringement_notices_select" on "public"."infringement_notices"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "infringement_notices_update" on "public"."infringement_notices"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."infringement_notices" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."infringement_notices" is 'Issued infringement notices under FCA 2011 s.20. Sequential notice numbers, PDF stored in notice-artifacts bucket.';
