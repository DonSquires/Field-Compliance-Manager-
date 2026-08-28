create table "public"."parking_infringement_notices" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "chalk_record_id"     uuid,
  "notice_number"       text                     not null,
  "plate_number"        text                     not null,
  "zone_name"           text,
  "zone_id"             uuid,
  "client_site_id"      uuid,
  "offence_description" text,
  "amount"              numeric(10,2),
  "status"              text                     not null default 'draft'::text,
  "issued_at"           timestamp with time zone,
  "issued_by"           uuid,
  "officer_name"        text,
  "evidence_photo_urls" jsonb,
  "legislative_text"    text,
  "created_at"          timestamp with time zone not null default now(),
  "updated_at"          timestamp with time zone not null default now(),
  constraint "parking_infringement_notices_chalk_record_id_fkey" foreign key (chalk_record_id) references public.parking_chalk_records(id) on delete set null,
  constraint "parking_infringement_notices_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete set null,
  constraint "parking_infringement_notices_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "parking_infringement_notices_pkey" primary key (id),
  constraint "parking_infringement_notices_status_check" check ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'disputed'::text, 'cancelled'::text]))),
  constraint "parking_infringement_notices_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete set null,
  constraint "uq_parking_infringement_notices_org_number" unique (organization_id, notice_number),
  constraint "parking_infringement_notices_issued_by_fkey" foreign key (issued_by) references public.user_profiles(id) on delete set null
);

alter table "public"."parking_infringement_notices"
  enable row level security;

create unique index idx_parking_infringement_notices_chalk_active_unique on public.parking_infringement_notices using btree (chalk_record_id)
  where ((chalk_record_id is not null) AND (status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'disputed'::text])));

create index idx_parking_infringement_notices_chalk_record on public.parking_infringement_notices using btree (chalk_record_id);

create index idx_parking_infringement_notices_org_status on public.parking_infringement_notices using btree (organization_id, status);

create index idx_parking_infringement_notices_plate_org on public.parking_infringement_notices using btree (plate_number, organization_id);

create trigger trg_parking_infringement_notices_check_transition
  before update on public.parking_infringement_notices
  for each row
  execute function public.parking_infringement_notices_check_transition();

create trigger trg_parking_infringement_notices_updated_at
  before update on public.parking_infringement_notices
  for each row
  execute function public.parking_infringement_notices_set_updated_at();

create policy "bob_full_read" on "public"."parking_infringement_notices"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "pin_insert" on "public"."parking_infringement_notices"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "pin_select" on "public"."parking_infringement_notices"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "pin_update" on "public"."parking_infringement_notices"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."parking_infringement_notices"
  to "anon", "authenticated", "postgres", "service_role";

comment on index "public"."idx_parking_infringement_notices_chalk_active_unique" is 'Dedup guard: at most one active (non-cancelled) infringement notice per chalk record. Prevents duplicate notices from concurrent officer actions. 0233 CC2 fix.';

comment on table "public"."parking_infringement_notices" is 'Parking infringement notices with lifecycle tracking (draft/issued/paid/disputed/cancelled). Issue #114. Separate from the legacy FC public.infringement_notices table (migration 0009) which has a different schema and status enum — see migration 0230/0231 for the history of this split.';
