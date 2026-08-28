create table "public"."wf_runs" (
  "id"             uuid                     not null default gen_random_uuid(),
  "job_id"         uuid                     not null,
  "runner_id"      text                     not null,
  "picked_up_at"   timestamp with time zone,
  "finished_at"    timestamp with time zone,
  "result_summary" jsonb,
  "created_at"     timestamp with time zone not null default now(),
  constraint "wf_runs_job_id_fkey" foreign key (job_id) references public.wf_jobs(id) on delete cascade,
  constraint "wf_runs_pkey" primary key (id)
);

alter table "public"."wf_runs"
  enable row level security;

alter table "public"."wf_runs"
  add column "status" public.wf_run_status not null default 'queued'::public.wf_run_status;

create index wf_runs_job_idx on public.wf_runs using btree (job_id);

create policy "bob_full_read" on "public"."wf_runs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_runs_insert_policy" on "public"."wf_runs"
  for insert
  to "authenticated"
  with
    check
    (((( SELECT public.wf_has_role('runner'::public.wf_app_role) AS wf_has_role) OR ( SELECT public.wf_has_role('operator'::public.wf_app_role) AS wf_has_role)) AND (EXISTS (
    SELECT 1
   FROM public.wf_jobs j
  WHERE ((j.id = wf_runs.job_id) AND (j.state = 'ratified'::public.wf_job_state))))));

create policy "wf_runs_select_policy" on "public"."wf_runs"
  for select
  to "authenticated"
  using ((exists ( select 1
   from public.wf_jobs j
  where
    ((j.id = wf_runs.job_id) AND ((j.created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('runner'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('operator'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or
    ( select public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role))))));

create policy "wf_runs_update_policy" on "public"."wf_runs"
  for update
  to "authenticated"
  using ((( select public.wf_has_role('runner'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('operator'::public.wf_app_role) as wf_has_role)))
  with check (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_runs" to "anon", "authenticated", "postgres", "service_role";
