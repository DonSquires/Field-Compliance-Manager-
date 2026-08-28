create table "public"."zone_legal_config" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "zone_id"               uuid                     not null,
  "payment_url"           text,
  "payment_deadline_days" integer                  not null default 28,
  "infringement_amount"   numeric(10,2),
  "objections_email"      text,
  "objections_address"    text,
  "issuing_authority"     text,
  "authorising_act"       text,
  "authorising_section"   text,
  "dispute_portal_url"    text,
  "council_phone"         text,
  "council_email"         text,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  constraint "zone_legal_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "zone_legal_config_pkey" primary key (id),
  constraint "zone_legal_config_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "zone_legal_config_zone_id_key" unique (zone_id)
);

alter table "public"."zone_legal_config"
  enable row level security;

create index idx_zone_legal_config_zone on public.zone_legal_config using btree (zone_id);

create policy "bob_full_read" on "public"."zone_legal_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "zone_legal_config_insert" on "public"."zone_legal_config"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "zone_legal_config_select" on "public"."zone_legal_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "zone_legal_config_update" on "public"."zone_legal_config"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."zone_legal_config" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."zone_legal_config" is 'Payment, objections, and dispute portal config per zone. Appears on generated notices.';
