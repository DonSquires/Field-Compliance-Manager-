create table "public"."shift_stop_actions" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "shift_stop_id"        uuid                     not null,
  "shift_id"             uuid                     not null,
  "action_type"          text                     not null,
  "result_record_id"     uuid,
  "result_table"         text,
  "outcome"              text,
  "notes"                text,
  "gps_lat"              double precision,
  "gps_lng"              double precision,
  "performed_at"         timestamp with time zone not null default now(),
  "created_at"           timestamp with time zone not null default now(),
  "shift_stop_module_id" uuid,
  constraint "shift_stop_actions_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "shift_stop_actions_pkey" primary key (id),
  constraint "shift_stop_actions_shift_stop_module_id_fkey" foreign key (shift_stop_module_id) references public.shift_stop_modules(id) on delete set null,
  constraint "shift_stop_actions_shift_stop_id_fkey" foreign key (shift_stop_id) references public.shift_stops(id) on delete cascade,
  constraint "shift_stop_actions_shift_id_fkey" foreign key (shift_id) references public.shifts(id) on delete cascade
);

alter table "public"."shift_stop_actions"
  enable row level security;

create index idx_ssa_shift_id on public.shift_stop_actions using btree (shift_id);

create index idx_ssa_shift_stop_id on public.shift_stop_actions using btree (shift_stop_id);

create index idx_ssa_shift_stop_module on public.shift_stop_actions using btree (shift_stop_module_id)
  where (shift_stop_module_id is not null);

create policy "bob_full_read" on "public"."shift_stop_actions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shift_stop_actions_insert" on "public"."shift_stop_actions"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "shift_stop_actions_select" on "public"."shift_stop_actions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_stop_actions" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."shift_stop_actions"."shift_stop_module_id" is 'Optional link to the specific module task this action belongs to (unified stop model, !709). Null = a stop-level event (e.g. arrival GPS); set = a module-level event (e.g. an FC inspection outcome).';

comment on table "public"."shift_stop_actions" is 'Module-specific actions completed at each shift stop. Audit trail for vehicle scans, checkpoints, evidence, and other field actions.';
