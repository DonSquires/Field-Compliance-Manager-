create table "public"."tender_documents" (
  "id"            uuid                     not null default gen_random_uuid(),
  "tender_id"     uuid                     not null,
  "document_name" text                     not null,
  "document_type" text,
  "storage_path"  text                     not null,
  "uploaded_by"   uuid,
  "created_at"    timestamp with time zone not null default now(),
  constraint "tender_documents_document_type_check" check ((document_type = ANY (ARRAY['proposal'::text, 'contract'::text, 'clause'::text, 'reference'::text, 'other'::text]))),
  constraint "tender_documents_pkey" primary key (id),
  constraint "tender_documents_tender_id_fkey" foreign key (tender_id) references public.tenders(id) on delete cascade,
  constraint "tender_documents_uploaded_by_fkey" foreign key (uploaded_by) references public.user_profiles(id)
);

alter table "public"."tender_documents"
  enable row level security;

create index idx_tender_documents_tender on public.tender_documents using btree (tender_id);

create policy "bob_full_read" on "public"."tender_documents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "tender_documents_insert" on "public"."tender_documents"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.tenders t
  WHERE ((t.id = tender_documents.tender_id) AND public.is_admin_for_org(t.organization_id) AND (EXISTS ( SELECT 1
           FROM public.user_profiles up
          WHERE ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))))));

create policy "tender_documents_select" on "public"."tender_documents"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.tenders t
  where ((t.id = tender_documents.tender_id) AND public.org_access_allowed(t.organization_id) AND (exists ( select 1
           from public.user_profiles up
          where ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text])))))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."tender_documents" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."tender_documents" is 'Document attachments for tenders.';
