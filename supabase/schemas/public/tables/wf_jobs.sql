create table "public"."wf_jobs" (
  "id"          uuid                     not null default gen_random_uuid(),
  "title"       text                     not null,
  "payload"     jsonb                    not null default '{}'::jsonb,
  "created_by"  uuid                     not null,
  "created_at"  timestamp with time zone not null default now(),
  "updated_at"  timestamp with time zone not null default now(),
  "verified_at" timestamp with time zone,
  "ratified_at" timestamp with time zone,
  "promoted_at" timestamp with time zone,
  constraint "wf_jobs_created_by_fkey" foreign key (created_by) references auth.users(id),
  constraint "wf_jobs_pkey" primary key (id)
);

alter table "public"."wf_jobs"
  enable row level security;

alter table "public"."wf_jobs"
  add column "state" public.wf_job_state not null default 'draft'::public.wf_job_state;

create index wf_jobs_created_by_idx on public.wf_jobs using btree (created_by);

create index wf_jobs_state_idx on public.wf_jobs using btree (state);

create trigger wf_jobs_set_updated_at
  before update on public.wf_jobs
  for each row
  execute function public.wf_set_updated_at();

create policy "bob_full_read" on "public"."wf_jobs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_jobs_insert_policy" on "public"."wf_jobs"
  for insert
  to "authenticated"
  with check ((created_by = ( SELECT auth.uid() AS uid)));

create policy "wf_jobs_select_policy" on "public"."wf_jobs"
  for select
  to "authenticated"
  using
    (((created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('operator'::public.wf_app_role) as wf_has_role) or
    ( select public.wf_has_role('runner'::public.wf_app_role) as wf_has_role)));

create policy "wf_jobs_update_policy" on "public"."wf_jobs"
  for update
  to "authenticated"
  using
    (((created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('operator'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role) or
    ( select public.wf_has_role('runner'::public.wf_app_role) as wf_has_role)))
  with check (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_jobs" to "anon", "authenticated", "postgres", "service_role";
