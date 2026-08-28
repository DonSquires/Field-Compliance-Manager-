create table "public"."formal_decision_records" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "evidence_id"       uuid                     not null,
  "approval_id"       uuid,
  "decision_type"     text                     not null,
  "rendered_template" text,
  "record_status"     text                     not null default 'draft'::text,
  "issued_at"         timestamp with time zone,
  "metadata"          jsonb                    not null default '{}'::jsonb,
  "created_by"        uuid,
  "created_at"        timestamp with time zone not null default now(),
  constraint "formal_decision_records_approval_id_fkey" foreign key (approval_id) references public.formal_decision_approvals(id) on delete set null,
  constraint "formal_decision_records_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id) on delete cascade,
  constraint "formal_decision_records_pkey" primary key (id),
  constraint "formal_decision_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "formal_decision_records_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."formal_decision_records"
  enable row level security;

create index idx_fdr_evidence on public.formal_decision_records using btree (evidence_id);

create index idx_fdr_org on public.formal_decision_records using btree (organization_id);

create policy "bob_full_read" on "public"."formal_decision_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "fdr_org_select" on "public"."formal_decision_records"
  for select
  to "authenticated"
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."formal_decision_records" to "anon", "authenticated", "postgres", "service_role";
