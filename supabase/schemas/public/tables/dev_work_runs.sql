create table "public"."dev_work_runs" (
  "id"              uuid                     not null default gen_random_uuid(),
  "work_request_id" uuid                     not null,
  "run_number"      integer                  not null,
  "status"          text                     not null,
  "worker_name"     text,
  "worker_host"     text,
  "started_at"      timestamp with time zone,
  "finished_at"     timestamp with time zone,
  "exit_summary"    text,
  "branch_name"     text,
  "commit_ref"      text,
  "test_summary"    jsonb,
  "build_summary"   jsonb,
  "failure_summary" text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "dev_work_runs_pkey" primary key (id),
  constraint "dev_work_runs_run_number_check" check ((run_number > 0)),
  constraint "dev_work_runs_status_check" check ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
  constraint "dev_work_runs_work_request_id_fkey" foreign key (work_request_id) references public.dev_work_requests(id) on delete cascade,
  constraint "dev_work_runs_work_request_id_run_number_key" unique (work_request_id, run_number)
);

alter table "public"."dev_work_runs"
  enable row level security;

create index dev_work_runs_status_idx on public.dev_work_runs using btree (status);

create index dev_work_runs_wr_created_idx on public.dev_work_runs using btree (work_request_id, created_at desc);

create policy "bob_full_read" on "public"."dev_work_runs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_runs"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_work_runs" to "anon", "authenticated", "postgres", "service_role";
