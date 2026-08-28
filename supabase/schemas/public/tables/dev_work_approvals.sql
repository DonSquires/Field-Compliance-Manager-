create table "public"."dev_work_approvals" (
  "id"              uuid                     not null default gen_random_uuid(),
  "work_request_id" uuid                     not null,
  "approval_stage"  text                     not null,
  "decision"        text                     not null,
  "decided_by"      uuid,
  "decision_note"   text,
  "created_at"      timestamp with time zone not null default now(),
  "decided_at"      timestamp with time zone,
  constraint "dev_work_approvals_approval_stage_check" check ((approval_stage = ANY (ARRAY['verify'::text, 'ratify'::text, 'promote'::text]))),
  constraint "dev_work_approvals_check" check ((((decision = 'pending'::text) AND (decided_at IS NULL)) OR (decision = ANY (ARRAY['approved'::text, 'rejected'::text])))),
  constraint "dev_work_approvals_decided_by_fkey" foreign key (decided_by) references auth.users(id),
  constraint "dev_work_approvals_decision_check" check ((decision = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
  constraint "dev_work_approvals_pkey" primary key (id),
  constraint "dev_work_approvals_work_request_id_fkey" foreign key (work_request_id) references public.dev_work_requests(id) on delete cascade
);

alter table "public"."dev_work_approvals"
  enable row level security;

create index dev_work_approvals_wr_stage_created_idx on public.dev_work_approvals using btree (work_request_id, approval_stage, created_at desc);

create policy "bob_full_read" on "public"."dev_work_approvals"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_approvals"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_work_approvals" to "anon", "authenticated", "postgres", "service_role";
