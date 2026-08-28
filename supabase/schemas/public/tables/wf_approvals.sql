create table "public"."wf_approvals" (
  "id"         uuid                     not null default gen_random_uuid(),
  "job_id"     uuid                     not null,
  "comment"    text,
  "decided_by" uuid                     not null,
  "decided_at" timestamp with time zone not null default now(),
  constraint "wf_approvals_decided_by_fkey" foreign key (decided_by) references auth.users(id),
  constraint "wf_approvals_pkey" primary key (id),
  constraint "wf_approvals_job_id_fkey" foreign key (job_id) references public.wf_jobs(id) on delete cascade
);

alter table "public"."wf_approvals"
  enable row level security;

alter table "public"."wf_approvals"
  add column "decision" public.wf_approval_decision not null;

alter table "public"."wf_approvals"
  add column "stage" public.wf_approval_stage not null;

create index wf_approvals_job_idx on public.wf_approvals using btree (job_id);

create policy "bob_full_read" on "public"."wf_approvals"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_approvals_insert_policy" on "public"."wf_approvals"
  for insert
  to "authenticated"
  with
    check
    (((decided_by = ( SELECT auth.uid() AS uid)) AND (((stage = 'verify'::public.wf_approval_stage) AND ( SELECT public.wf_has_role('verifier'::public.wf_app_role) AS wf_has_role))
    OR ((stage = 'ratify'::public.wf_approval_stage) AND ( SELECT public.wf_has_role('ratifier'::public.wf_app_role) AS wf_has_role)))));

create policy "wf_approvals_select_policy" on "public"."wf_approvals"
  for select
  to "authenticated"
  using ((exists ( select 1
   from public.wf_jobs j
  where
    ((j.id = wf_approvals.job_id) AND ((j.created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('operator'::public.wf_app_role) as wf_has_role))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_approvals" to "anon", "authenticated", "postgres", "service_role";
