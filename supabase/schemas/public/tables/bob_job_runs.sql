create table "public"."bob_job_runs" (
  "id"              uuid                     not null default gen_random_uuid(),
  "job_id"          uuid                     not null,
  "organization_id" uuid,
  "actor_id"        uuid,
  "parent_agent"    text,
  "goal"            text                     not null,
  "approval_mode"   text                     not null default 'advisory'::text,
  "contains_writes" boolean                  not null default false,
  "status"          text                     not null default 'completed'::text,
  "stopped_reason"  text,
  "steps"           jsonb                    not null default '[]'::jsonb,
  "clarifications"  jsonb                    not null default '[]'::jsonb,
  "created_at"      timestamp with time zone not null default now(),
  constraint "bob_job_runs_pkey" primary key (id),
  constraint "bob_job_runs_status_check" check ((status = ANY (ARRAY['completed'::text, 'stopped'::text, 'awaiting_approval'::text, 'failed'::text]))),
  constraint "bob_job_runs_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete set null,
  constraint "bob_job_runs_actor_id_fkey" foreign key (actor_id) references public.user_profiles(id) on delete set null
);

alter table "public"."bob_job_runs"
  enable row level security;

create index idx_bob_job_runs_created on public.bob_job_runs using btree (created_at desc);

create index idx_bob_job_runs_job_id on public.bob_job_runs using btree (job_id);

create index idx_bob_job_runs_org on public.bob_job_runs using btree (organization_id);

create policy "bob_full_read" on "public"."bob_job_runs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_job_runs_select" on "public"."bob_job_runs"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "bob_job_runs_write" on "public"."bob_job_runs"
  for all
  to PUBLIC
  using (((organization_id is not null) AND public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_job_runs" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_job_runs" is 'Audit trail of governed Bob job runs (bob-job-runner). Records goal, steps, outcomes, and write results for accountability + rollback.';
