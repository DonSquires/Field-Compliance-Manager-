create table "public"."travel_allowances" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "callout_shift_id"     uuid,
  "officer_user_id"      uuid                     not null,
  "journey_type"         text                     not null,
  "distance_km"          numeric(8,2),
  "duration_minutes"     integer,
  "rate_per_km"          numeric(6,4),
  "time_rate"            numeric(10,2),
  "outside_jurisdiction" boolean                  not null default false,
  "created_at"           timestamp with time zone not null default now(),
  constraint "travel_allowances_callout_shift_id_fkey" foreign key (callout_shift_id) references public.callout_shifts(id),
  constraint "travel_allowances_journey_type_check" check ((journey_type = ANY (ARRAY['outbound'::text, 'return'::text, 'round_trip'::text]))),
  constraint "travel_allowances_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "travel_allowances_pkey" primary key (id),
  constraint "travel_allowances_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."travel_allowances"
  enable row level security;

create policy "bob_full_read" on "public"."travel_allowances"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "travel_allowances_select" on "public"."travel_allowances"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."travel_allowances" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."travel_allowances" is 'Travel reimbursement per callout. Calculated from officer registered office location.';
