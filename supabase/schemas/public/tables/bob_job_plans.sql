create table "public"."bob_job_plans" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "created_by"      uuid,
  "conversation_id" uuid,
  "goal"            text                     not null,
  "status"          text                     not null default 'draft'::text,
  "approved_by"     uuid,
  "approved_at"     timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "reasoning"       text,
  constraint "bob_job_plans_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete set null,
  constraint "bob_job_plans_pkey" primary key (id),
  constraint "bob_job_plans_status_check"
    check ((status = ANY (ARRAY['draft'::text, 'proposed'::text, 'executing'::text, 'needs_review'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
  constraint "bob_job_plans_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_job_plans_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id),
  constraint "bob_job_plans_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."bob_job_plans"
  enable row level security;

create index idx_bob_job_plans_executing on public.bob_job_plans using btree (status)
  where (status = ANY (ARRAY['executing'::text, 'needs_review'::text]));

create index idx_bob_job_plans_org_status on public.bob_job_plans using btree (organization_id, status);

create policy "bjp_insert" on "public"."bob_job_plans"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bjp_select" on "public"."bob_job_plans"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bjp_update" on "public"."bob_job_plans"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_job_plans"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_job_plans" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_job_plans"."reasoning" is 'Why this plan was assembled -- caller-supplied or a generated default ("Bob assembled a N-step plan: <goal>"). Shown to the human alongside the plan when reviewing it for approval. #86 Phase 3.';

comment on table "public"."bob_job_plans" is 'A durable, ordered, multi-step Bob plan (e.g. "backfill 9 LINZ zone geofences"). Wraps bob_agentic_actions -- each step still creates/executes a real governed action; this table only sequences them so a human approves the whole plan once instead of re-prompting Bob at every step. #86 Phase 3.';
