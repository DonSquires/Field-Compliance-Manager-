create table "public"."formal_decision_approvals" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "organization_id"              uuid                     not null,
  "evidence_id"                  uuid                     not null,
  "requested_by"                 uuid,
  "decision_type"                text                     not null,
  "approval_status"              text                     not null default 'pending'::text,
  "requires_supervisor_approval" boolean                  not null default false,
  "requires_legal_review"        boolean                  not null default false,
  "summary_approval_id"          uuid,
  "formal_use"                   jsonb                    not null default '{}'::jsonb,
  "approval_gate"                jsonb                    not null default '{}'::jsonb,
  "supervisor_approved_by"       uuid,
  "legal_approved_by"            uuid,
  "decided_at"                   timestamp with time zone,
  "notes"                        text,
  "created_at"                   timestamp with time zone not null default now(),
  constraint "formal_decision_approvals_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id) on delete cascade,
  constraint "formal_decision_approvals_pkey" primary key (id),
  constraint "formal_decision_approvals_summary_approval_id_fkey" foreign key (summary_approval_id) references public.evidence_summary_approvals(id) on delete set null,
  constraint "formal_decision_approvals_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "formal_decision_approvals_legal_approved_by_fkey" foreign key (legal_approved_by) references public.user_profiles(id),
  constraint "formal_decision_approvals_requested_by_fkey" foreign key (requested_by) references public.user_profiles(id),
  constraint "formal_decision_approvals_supervisor_approved_by_fkey" foreign key (supervisor_approved_by) references public.user_profiles(id)
);

alter table "public"."formal_decision_approvals"
  enable row level security;

create index idx_fda_evidence on public.formal_decision_approvals using btree (evidence_id);

create index idx_fda_org on public.formal_decision_approvals using btree (organization_id);

create policy "bob_full_read" on "public"."formal_decision_approvals"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "fda_org_select" on "public"."formal_decision_approvals"
  for select
  to "authenticated"
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."formal_decision_approvals" to "anon", "authenticated", "postgres", "service_role";
