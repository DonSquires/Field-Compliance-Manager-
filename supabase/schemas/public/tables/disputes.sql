create table "public"."disputes" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "notice_id"       uuid,
  "submitter_name"  text,
  "submitter_email" text,
  "submitter_phone" text,
  "grounds"         text,
  "bob_analysis"    text,
  "bob_confidence"  real,
  "status"          text                     not null default 'received'::text,
  "decision_note"   text,
  "decided_by"      uuid,
  "decided_at"      timestamp with time zone,
  "submitted_at"    timestamp with time zone not null default now(),
  "created_at"      timestamp with time zone not null default now(),
  "notice_number"   text,
  "dispute_type"    text,
  "plate_number"    text,
  "notice_date"     date,
  "scv_number"      text,
  "statement"       text,
  "review_notes"    text,
  "reviewed_by"     uuid,
  "reviewed_at"     timestamp with time zone,
  constraint "disputes_pkey" primary key (id),
  constraint "disputes_status_check" check ((status = ANY (ARRAY['received'::text, 'under_review'::text, 'upheld'::text, 'withdrawn'::text, 'referred'::text, 'dismissed'::text]))),
  constraint "disputes_notice_id_fkey" foreign key (notice_id) references public.infringement_notices(id),
  constraint "disputes_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "disputes_decided_by_fkey" foreign key (decided_by) references public.user_profiles(id),
  constraint "disputes_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id)
);

alter table "public"."disputes"
  enable row level security;

create policy "bob_full_read" on "public"."disputes"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "disputes_select" on "public"."disputes"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "disputes_update" on "public"."disputes"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."disputes" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."disputes"."notice_number" is 'Notice number as entered by the disputer (used to resolve notice_id/org).';

comment on column "public"."disputes"."review_notes" is 'Internal admin review notes (distinct from decision_note).';

comment on column "public"."disputes"."statement" is 'Free-text dispute statement from the public portal.';

comment on table "public"."disputes" is 'Notice disputes (org-scoped via organization_id, linked via notice_id). SELECT: org_access_allowed. UPDATE: admin (review decisions). INSERT is via the submit-dispute service-role edge function, not anon.';
