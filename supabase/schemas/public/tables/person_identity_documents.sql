create table "public"."person_identity_documents" (
  "id"                    uuid  not null default gen_random_uuid(),
  "person_record_id"      uuid,
  "evidence_item_id"      uuid,
  "document_kind"         text,
  "extracted_fields"      jsonb not null default '{}'::jsonb,
  "id_photo_storage_path" text,
  "review_state"          text  not null default 'manual_review_required'::text,
  constraint "person_identity_documents_evidence_item_id_fkey" foreign key (evidence_item_id) references public.evidence_items(id),
  constraint "person_identity_documents_pkey" primary key (id),
  constraint "person_identity_documents_person_record_id_fkey" foreign key (person_record_id) references public.person_records(id) on delete cascade
);

alter table "public"."person_identity_documents"
  enable row level security;

create policy "bob_full_read" on "public"."person_identity_documents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "person_identity_documents_select" on "public"."person_identity_documents"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.person_records p
  where ((p.id = person_identity_documents.person_record_id) AND public.org_access_allowed(p.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."person_identity_documents" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."person_identity_documents" is 'ID/OCR results linked to a person record. Always requires human review.';
