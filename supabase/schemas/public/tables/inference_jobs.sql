create table "public"."inference_jobs" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "evidence_item_id"     uuid,
  "domain"               text                     not null,
  "status"               text                     not null default 'queued'::text,
  "requested_by_user_id" uuid,
  "created_at"           timestamp with time zone not null default now(),
  "completed_at"         timestamp with time zone,
  constraint "inference_jobs_domain_check"
    check ((domain = ANY (ARRAY['vehicle'::text, 'face'::text, 'identity_document'::text, 'ocr'::text, 'audio'::text, 'bob_reasoning'::text]))),
  constraint "inference_jobs_evidence_item_id_fkey" foreign key (evidence_item_id) references public.evidence_items(id),
  constraint "inference_jobs_pkey" primary key (id),
  constraint "inference_jobs_status_check"
    check ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'complete'::text, 'inconclusive'::text, 'manual_review_required'::text, 'failed'::text]))),
  constraint "inference_jobs_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "inference_jobs_requested_by_user_id_fkey" foreign key (requested_by_user_id) references public.user_profiles(id)
);

alter table "public"."inference_jobs"
  enable row level security;

create policy "bob_full_read" on "public"."inference_jobs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "inference_jobs_select" on "public"."inference_jobs"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."inference_jobs" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."inference_jobs" is 'Shared inference work queue. Supports vehicle, face, ID/OCR, audio, and Bob reasoning.';
