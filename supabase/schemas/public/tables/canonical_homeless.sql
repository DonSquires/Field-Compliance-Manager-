create table "public"."canonical_homeless" (
  "id"              uuid                     not null default gen_random_uuid(),
  "plate_number"    text                     not null,
  "status"          text                     not null default 'homeless'::text,
  "support_agency"  text,
  "support_contact" text,
  "notes"           text,
  "flagged_by_org"  uuid,
  "flagged_at"      timestamp with time zone not null default now(),
  "resolved_at"     timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "canonical_homeless_pkey" primary key (id),
  constraint "canonical_homeless_plate_number_key" unique (plate_number),
  constraint "canonical_homeless_status_check" check ((status = ANY (ARRAY['homeless'::text, 'flagged'::text, 'welfare_referral'::text, 'resolved'::text]))),
  constraint "canonical_homeless_flagged_by_org_fkey" foreign key (flagged_by_org) references public.organizations(id)
);

alter table "public"."canonical_homeless"
  enable row level security;

create index idx_canonical_homeless_plate on public.canonical_homeless using btree (plate_number);

create index idx_canonical_homeless_status on public.canonical_homeless using btree (status);

create policy "bob_full_read" on "public"."canonical_homeless"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."canonical_homeless" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."canonical_homeless" is 'Homeless/flagged status per plate. Triggers welfare referral instead of enforcement.';
