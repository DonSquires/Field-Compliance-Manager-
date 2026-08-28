create table "public"."wf_artifacts" (
  "id"          uuid                     not null default gen_random_uuid(),
  "job_id"      uuid                     not null,
  "run_id"      uuid,
  "bucket_id"   text                     not null,
  "object_path" text                     not null,
  "sha256"      text,
  "size_bytes"  bigint,
  "created_by"  uuid,
  "created_at"  timestamp with time zone not null default now(),
  constraint "wf_artifacts_created_by_fkey" foreign key (created_by) references auth.users(id),
  constraint "wf_artifacts_pkey" primary key (id),
  constraint "wf_artifacts_job_id_fkey" foreign key (job_id) references public.wf_jobs(id) on delete cascade,
  constraint "wf_artifacts_run_id_fkey" foreign key (run_id) references public.wf_runs(id) on delete set null
);

alter table "public"."wf_artifacts"
  enable row level security;

alter table "public"."wf_artifacts"
  add column "kind" public.wf_artifact_kind not null;

create index wf_artifacts_job_idx on public.wf_artifacts using btree (job_id);

create policy "bob_full_read" on "public"."wf_artifacts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_artifacts_insert_policy" on "public"."wf_artifacts"
  for insert
  to "authenticated"
  with check ((( SELECT public.wf_has_role('runner'::public.wf_app_role) AS wf_has_role) OR ( SELECT public.wf_has_role('operator'::public.wf_app_role) AS wf_has_role)));

create policy "wf_artifacts_select_policy" on "public"."wf_artifacts"
  for select
  to "authenticated"
  using ((exists ( select 1
   from public.wf_jobs j
  where
    ((j.id = wf_artifacts.job_id) AND ((j.created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('runner'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('operator'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or
    ( select public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_artifacts" to "anon", "authenticated", "postgres", "service_role";
