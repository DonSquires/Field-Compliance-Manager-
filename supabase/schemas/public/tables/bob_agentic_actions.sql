create table "public"."bob_agentic_actions" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "user_id"              uuid                     not null,
  "action_type"          text                     not null,
  "context_page"         text,
  "context_record_id"    uuid,
  "context_table"        text,
  "proposed_payload"     jsonb                    not null default '{}'::jsonb,
  "status"               text                     not null default 'pending'::text,
  "approved_by"          uuid,
  "approved_at"          timestamp with time zone,
  "rejection_reason"     text,
  "result_record_id"     uuid,
  "result_table"         text,
  "error_message"        text,
  "bob_reasoning"        text,
  "confidence_score"     real,
  "created_at"           timestamp with time zone not null default now(),
  "applied_at"           timestamp with time zone,
  "conversation_id"      uuid,
  "context_summary"      text,
  "amended_payload"      jsonb,
  "amended_by"           uuid,
  "amended_at"           timestamp with time zone,
  "idempotency_key"      text,
  "triggered_by"         uuid,
  "assigned_approver_id" uuid,
  "reassigned_by"        uuid,
  "reassigned_at"        timestamp with time zone,
  constraint "bob_agentic_actions_pkey" primary key (id),
  constraint "bob_agentic_actions_status_check" check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'failed'::text]))),
  constraint "bob_agentic_actions_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete set null,
  constraint "bob_agentic_actions_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_agentic_actions_amended_by_fkey" foreign key (amended_by) references public.user_profiles(id),
  constraint "bob_agentic_actions_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id),
  constraint "bob_agentic_actions_assigned_approver_id_fkey" foreign key (assigned_approver_id) references public.user_profiles(id) on delete set null,
  constraint "bob_agentic_actions_reassigned_by_fkey" foreign key (reassigned_by) references public.user_profiles(id) on delete set null,
  constraint "bob_agentic_actions_triggered_by_fkey" foreign key (triggered_by) references public.user_profiles(id) on delete set null,
  constraint "bob_agentic_actions_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."bob_agentic_actions"
  enable row level security;

create index idx_baa_org_status on public.bob_agentic_actions using btree (organization_id, status);

create index idx_baa_user_id on public.bob_agentic_actions using btree (user_id);

create index idx_bob_agentic_actions_assigned_approver on public.bob_agentic_actions using btree (assigned_approver_id)
  where (assigned_approver_id is not null);

create index idx_bob_agentic_actions_conversation_id on public.bob_agentic_actions using btree (conversation_id)
  where (conversation_id is not null);

create unique index idx_bob_agentic_actions_idempotency_pending on public.bob_agentic_actions using btree (idempotency_key)
  where ((status = 'pending'::text) AND (idempotency_key is not null));

create index idx_bob_agentic_actions_status on public.bob_agentic_actions using btree (status, created_at desc);

create index idx_bob_agentic_actions_triggered_by on public.bob_agentic_actions using btree (triggered_by)
  where (triggered_by is not null);

create policy "baa_insert" on "public"."bob_agentic_actions"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "baa_select" on "public"."bob_agentic_actions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "baa_update" on "public"."bob_agentic_actions"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_agentic_actions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_agentic_actions" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_agentic_actions"."amended_at" is 'Timestamp of the amendment. Null if no amendment was made. #87.';

comment on column "public"."bob_agentic_actions"."amended_by" is 'User who amended the payload before approval. Null if no amendment was made. #87.';

comment on column "public"."bob_agentic_actions"."amended_payload" is 'Human-edited version of proposed_payload. Null = no amendment; executor reads coalesce(amended_payload, proposed_payload). Bob''s original proposed_payload is never overwritten. #87.';

comment on column "public"."bob_agentic_actions"."assigned_approver_id" is 'The user this action is routed to for approval. Set by delegation (#16). NULL = routed by org-tree.';

comment on column "public"."bob_agentic_actions"."idempotency_key" is 'Structural dedup key for Pillar E (#140). Computed as action_type::makeSlotKey(kind, name).
  Partial unique index on (idempotency_key) WHERE status = pending prevents duplicate
  proposals for the same entity within a conversation. Nullable: rows filed before this
  migration have no key and are not affected. Pillar E, epic #135.';

comment on column "public"."bob_agentic_actions"."reassigned_at" is 'When this action was reassigned. Audit trail.';

comment on column "public"."bob_agentic_actions"."reassigned_by" is 'Who reassigned this action to the current assigned_approver_id. Audit trail.';

comment on column "public"."bob_agentic_actions"."triggered_by" is 'The human who initiated this action (distinct from user_id which may be Bob). Used for doorbell routing (#16/#18).';

comment on column "public"."bob_agentic_actions"."user_id" is 'Proposer of the agentic action. For Bob-originated proposals this is the Bob system user (00000000-0000-0000-0000-00000000b0b0). The human who triggered it is recorded in proposed_payload.triggered_by; the human who approves is approved_by. Bob proposes, human approves — no second-human requirement.';

comment on table "public"."bob_agentic_actions" is 'Bob agentic action proposals. Every Bob write action requires human approval before being applied.';
