create table "public"."canonical_vehicles" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "plate_number"          text                     not null,
  "make"                  text,
  "model"                 text,
  "year"                  integer,
  "colour"                text,
  "body_type"             text,
  "fuel_type"             text,
  "registered_owner_name" text,
  "motorweb_enriched_at"  timestamp with time zone,
  "embedding_quality"     double precision,
  "last_seen_at"          timestamp with time zone,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  "homeless_status"       text                     not null default 'none'::text,
  "homeless_verified_at"  timestamp with time zone,
  "homeless_notes"        text,
  "rego_expiry"           date,
  "rego_status"           text,
  "wof_expiry"            date,
  "wof_status"            text,
  "cof_expiry"            date,
  "cof_status"            text,
  "compliance_checked_at" timestamp with time zone,
  "compliance_source"     text,
  constraint "canonical_vehicles_cof_status_check" check ((cof_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text]))),
  constraint "canonical_vehicles_compliance_source_check" check ((compliance_source = ANY (ARRAY['motoweb'::text, 'manual'::text, 'canonical'::text]))),
  constraint "canonical_vehicles_homeless_status_check" check ((homeless_status = ANY (ARRAY['none'::text, 'claiming'::text, 'investigating'::text, 'confirmed'::text]))),
  constraint "canonical_vehicles_pkey" primary key (id),
  constraint "canonical_vehicles_plate_number_key" unique (plate_number),
  constraint "canonical_vehicles_rego_status_check" check ((rego_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text]))),
  constraint "canonical_vehicles_wof_status_check" check ((wof_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text])))
);

alter table "public"."canonical_vehicles"
  enable row level security;

create index idx_canonical_vehicles_last_seen on public.canonical_vehicles using btree (last_seen_at desc);

create index idx_canonical_vehicles_plate on public.canonical_vehicles using btree (plate_number);

create index idx_canonical_vehicles_rego_status on public.canonical_vehicles using btree (rego_status);

create index idx_canonical_vehicles_wof_status on public.canonical_vehicles using btree (wof_status);

create policy "bob_full_read" on "public"."canonical_vehicles"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."canonical_vehicles" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."canonical_vehicles"."cof_expiry" is 'Certificate of Fitness expiry date. Applies to heavy vehicles (>=3500 kg).';

comment on column "public"."canonical_vehicles"."cof_status" is 'CoF status: current, expired, unknown. Derived from cof_expiry vs now().';

comment on column "public"."canonical_vehicles"."compliance_checked_at" is 'Timestamp of the last compliance check (rego/WoF/CoF lookup).';

comment on column "public"."canonical_vehicles"."compliance_source" is 'How compliance data was obtained: motoweb (API), manual (officer entry), canonical (seeded).';

comment on column "public"."canonical_vehicles"."homeless_status" is 'Independent homeless status for the vehicle (lived-in), separate from any person. Lifecycle: none -> claiming -> investigating -> confirmed. Reconciled to a person via entity_links (occupant/lives_in).';

comment on column "public"."canonical_vehicles"."rego_expiry" is 'NZ vehicle registration expiry date. Source: MotorWeb or manual entry.';

comment on column "public"."canonical_vehicles"."rego_status" is 'Registration status: current, expired, unknown. Derived from rego_expiry vs now().';

comment on column "public"."canonical_vehicles"."wof_expiry" is 'Warrant of Fitness expiry date. Applies to light vehicles (<3500 kg).';

comment on column "public"."canonical_vehicles"."wof_status" is 'WoF status: current, expired, unknown. Derived from wof_expiry vs now().';

comment on table "public"."canonical_vehicles" is 'Vehicle attributes per plate. Platform-level (cross-org). Source: ONNX + MotorWeb.';
