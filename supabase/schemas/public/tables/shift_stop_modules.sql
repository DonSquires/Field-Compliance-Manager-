create table "public"."shift_stop_modules" (
  "id"                            uuid                     not null default gen_random_uuid(),
  "organization_id"               uuid                     not null,
  "shift_stop_id"                 uuid                     not null,
  "module_key"                    text                     not null,
  "status"                        text                     not null default 'pending'::text,
  "is_required"                   boolean                  not null default true,
  "started_at"                    timestamp with time zone,
  "completed_at"                  timestamp with time zone,
  "outcome"                       text,
  "result_record_id"              uuid,
  "result_table"                  text,
  "created_at"                    timestamp with time zone not null default now(),
  "updated_at"                    timestamp with time zone not null default now(),
  "service_agreement_module_id"   uuid,
  "service_agreement_location_id" uuid,
  constraint "shift_stop_modules_module_key_check"
    check
    ((module_key = ANY (ARRAY['freedom_camping'::text, 'parking_enforcement'::text, 'noise_control'::text, 'biosecurity'::text, 'smoke_complaints'::text, 'static_guarding'::text,
    'access_control'::text, 'ems'::text, 'alarm_response'::text, 'welfare_check'::text, 'general_patrol'::text]))),
  constraint "shift_stop_modules_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "shift_stop_modules_pkey" primary key (id),
  constraint "shift_stop_modules_service_agreement_location_id_fkey" foreign key (service_agreement_location_id) references public.service_agreement_locations(id) on delete
    set null,
  constraint "shift_stop_modules_service_agreement_module_id_fkey" foreign key (service_agreement_module_id) references public.service_agreement_modules(id) on delete set null,
  constraint "shift_stop_modules_shift_stop_id_module_key_key" unique (shift_stop_id, module_key),
  constraint "shift_stop_modules_status_check" check ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text, 'failed'::text]))),
  constraint "shift_stop_modules_shift_stop_id_fkey" foreign key (shift_stop_id) references public.shift_stops(id) on delete cascade
);

alter table "public"."shift_stop_modules"
  enable row level security;

create index idx_ssm_org_status on public.shift_stop_modules using btree (organization_id, status);

create index idx_ssm_sal on public.shift_stop_modules using btree (service_agreement_location_id)
  where (service_agreement_location_id is not null);

create index idx_ssm_sam on public.shift_stop_modules using btree (service_agreement_module_id)
  where (service_agreement_module_id is not null);

create index idx_ssm_shift_stop on public.shift_stop_modules using btree (shift_stop_id);

create policy "bob_full_read" on "public"."shift_stop_modules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ssm_insert" on "public"."shift_stop_modules"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "ssm_select" on "public"."shift_stop_modules"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ssm_update" on "public"."shift_stop_modules"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_stop_modules" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."shift_stop_modules"."service_agreement_location_id" is 'The authorising service_agreement_location (place-contract) for this run-time module. Inherited from patrol_route_stop_modules at shift generation. Nullable for back-compat.';

comment on column "public"."shift_stop_modules"."service_agreement_module_id" is 'The authorising service_agreement_module for this run-time module attendance. Inherited from patrol_route_stop_modules at shift generation (generate_shift_stops). Nullable for back-compat. Exactly ONE authorising contract per attendance. Owner ruling 2026-08-15: contract attribution at MODULE grain, #328.';

comment on table "public"."shift_stop_modules" is 'Run-time module task for a shift stop (unified stop model, !709). One attendance (shift_stop) can have N module tasks, each with its own completion/outcome. Attendance KPIs (shift_stops) and module-outcome KPIs (this table) are cleanly separable.';
