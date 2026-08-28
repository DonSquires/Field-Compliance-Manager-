create table "public"."bob_job_plan_steps" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "plan_id"               uuid                     not null,
  "sequence"              integer                  not null,
  "depends_on_step_id"    uuid,
  "action_type"           text                     not null,
  "proposed_payload"      jsonb                    not null default '{}'::jsonb,
  "status"                text                     not null default 'pending'::text,
  "bob_agentic_action_id" uuid,
  "error_message"         text,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  constraint "bob_job_plan_steps_bob_agentic_action_id_fkey" foreign key (bob_agentic_action_id) references public.bob_agentic_actions(id) on delete set null,
  constraint "bob_job_plan_steps_pkey" primary key (id),
  constraint "bob_job_plan_steps_depends_on_step_id_fkey" foreign key (depends_on_step_id) references public.bob_job_plan_steps(id) on delete set null,
  constraint "bob_job_plan_steps_plan_id_sequence_key" unique (plan_id, sequence),
  constraint "bob_job_plan_steps_status_check"
    check ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'applied'::text, 'failed'::text, 'needs_review'::text, 'skipped'::text]))),
  constraint "bob_job_plan_steps_plan_id_fkey" foreign key (plan_id) references public.bob_job_plans(id) on delete cascade
);

alter table "public"."bob_job_plan_steps"
  enable row level security;

create index idx_bob_job_plan_steps_plan_seq on public.bob_job_plan_steps using btree (plan_id, sequence);

create index idx_bob_job_plan_steps_ready on public.bob_job_plan_steps using btree (plan_id, status)
  where (status = 'ready'::text);

create policy "bjps_insert" on "public"."bob_job_plan_steps"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND public.org_access_allowed(p.organization_id)))));

create policy "bjps_select" on "public"."bob_job_plan_steps"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.bob_job_plans p
  where ((p.id = bob_job_plan_steps.plan_id) AND public.org_access_allowed(p.organization_id)))));

create policy "bjps_update" on "public"."bob_job_plan_steps"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.bob_job_plans p
  where ((p.id = bob_job_plan_steps.plan_id) AND public.org_access_allowed(p.organization_id)))))
  with check ((EXISTS ( SELECT 1
   FROM public.bob_job_plans p
  WHERE ((p.id = bob_job_plan_steps.plan_id) AND public.org_access_allowed(p.organization_id)))));

create policy "bob_full_read" on "public"."bob_job_plan_steps"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_job_plan_steps" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_job_plan_steps" is 'One step of a bob_job_plans plan. Each step, once run, points at the real bob_agentic_actions row it created/executed via bob_agentic_action_id -- the governed write itself is unchanged; this table only orders and tracks steps. #86 Phase 3.';
