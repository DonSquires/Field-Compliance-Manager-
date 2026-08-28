create table "public"."evidence_summary_approvals" (
  "id"                      uuid                     not null default gen_random_uuid(),
  "organization_id"         uuid                     not null,
  "evidence_id"             uuid                     not null,
  "requested_by"            uuid,
  "approval_status"         text                     not null default 'pending'::text,
  "requested_mode"          text,
  "redacted_labels"         text[]                   not null default '{}'::text[],
  "reason"                  text,
  "approved_by"             uuid,
  "decided_at"              timestamp with time zone,
  "generated_summary"       text,
  "generated_mode"          text,
  "generated_metadata"      jsonb                    not null default '{}'::jsonb,
  "generated_at"            timestamp with time zone,
  "generated_review_status" text,
  "generated_reviewed_by"   uuid,
  "generated_reviewed_at"   timestamp with time zone,
  "generated_review_notes"  text,
  "created_at"              timestamp with time zone not null default now(),
  constraint "evidence_summary_approvals_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id) on delete cascade,
  constraint "evidence_summary_approvals_pkey" primary key (id),
  constraint "evidence_summary_approvals_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "evidence_summary_approvals_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id),
  constraint "evidence_summary_approvals_generated_reviewed_by_fkey" foreign key (generated_reviewed_by) references public.user_profiles(id),
  constraint "evidence_summary_approvals_requested_by_fkey" foreign key (requested_by) references public.user_profiles(id)
);

alter table "public"."evidence_summary_approvals"
  enable row level security;

create index idx_esa_evidence on public.evidence_summary_approvals using btree (evidence_id);

create index idx_esa_org on public.evidence_summary_approvals using btree (organization_id);

create policy "bob_full_read" on "public"."evidence_summary_approvals"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "esa_org_select" on "public"."evidence_summary_approvals"
  for select
  to "authenticated"
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."evidence_summary_approvals" to "anon", "authenticated", "postgres", "service_role";
