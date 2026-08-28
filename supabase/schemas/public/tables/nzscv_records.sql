create table "public"."nzscv_records" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "vehicle_id"         uuid,
  "plate"              text                     not null,
  "status"             text                     not null,
  "certificate_number" text,
  "vehicle_class"      text,
  "expiry_date"        date,
  "raw_response"       jsonb                    not null default '{}'::jsonb,
  "checked_at"         timestamp with time zone not null default now(),
  "created_at"         timestamp with time zone not null default now(),
  constraint "nzscv_records_pkey" primary key (id),
  constraint "nzscv_records_status_check" check ((status = ANY (ARRAY['certified'::text, 'expired'::text, 'not_found'::text, 'unknown'::text, 'exempt'::text, 'pending'::text]))),
  constraint "nzscv_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "nzscv_records_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."nzscv_records"
  enable row level security;

create policy "bob_full_read" on "public"."nzscv_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "nzscv_records_select" on "public"."nzscv_records"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."nzscv_records" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."nzscv_records" is 'NZSCV certification records synced from the NZ Self-Contained Vehicle registry. Used by freedom camping compliance.';
