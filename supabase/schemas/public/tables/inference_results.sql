create table "public"."inference_results" (
  "id"               uuid                     not null default gen_random_uuid(),
  "inference_job_id" uuid,
  "evidence_item_id" uuid,
  "domain"           text                     not null,
  "status"           text                     not null,
  "confidence"       real,
  "result"           jsonb                    not null default '{}'::jsonb,
  "created_at"       timestamp with time zone not null default now(),
  constraint "inference_results_domain_check"
    check ((domain = ANY (ARRAY['vehicle'::text, 'face'::text, 'identity_document'::text, 'ocr'::text, 'audio'::text, 'bob_reasoning'::text]))),
  constraint "inference_results_evidence_item_id_fkey" foreign key (evidence_item_id) references public.evidence_items(id),
  constraint "inference_results_inference_job_id_fkey" foreign key (inference_job_id) references public.inference_jobs(id) on delete cascade,
  constraint "inference_results_pkey" primary key (id),
  constraint "inference_results_status_check" check ((status = ANY (ARRAY['complete'::text, 'inconclusive'::text, 'manual_review_required'::text, 'failed'::text])))
);

alter table "public"."inference_results"
  enable row level security;

create policy "bob_full_read" on "public"."inference_results"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "inference_results_select" on "public"."inference_results"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.evidence_items e
  where ((e.id = inference_results.evidence_item_id) AND public.org_access_allowed(e.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."inference_results" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."inference_results" is 'Structured inference output. Confidence and unknown/manual-review states are preserved.';
