create table "public"."staff_documents" (
  "id"              uuid                     not null default gen_random_uuid(),
  "staff_id"        uuid                     not null,
  "organization_id" uuid                     not null,
  "credential_id"   uuid,
  "document_type"   text                     not null,
  "file_name"       text                     not null,
  "storage_path"    text                     not null,
  "file_size_bytes" bigint,
  "mime_type"       text,
  "description"     text,
  "notes"           text,
  "uploaded_by"     uuid,
  "uploaded_at"     timestamp with time zone not null default now(),
  "expiry_date"     date,
  "created_at"      timestamp with time zone not null default now(),
  constraint "staff_documents_credential_id_fkey" foreign key (credential_id) references public.staff_credentials(id) on delete set null,
  constraint "staff_documents_document_type_check"
    check ((document_type = ANY (ARRAY['credential_evidence'::text, 'contract'::text, 'certificate'::text, 'policy_acknowledgement'::text, 'other'::text]))),
  constraint "staff_documents_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "staff_documents_pkey" primary key (id),
  constraint "staff_documents_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade,
  constraint "staff_documents_uploaded_by_fkey" foreign key (uploaded_by) references public.user_profiles(id)
);

alter table "public"."staff_documents"
  enable row level security;

create index idx_staff_documents_credential on public.staff_documents using btree (credential_id)
  where (credential_id is not null);

create index idx_staff_documents_org on public.staff_documents using btree (organization_id);

create index idx_staff_documents_staff on public.staff_documents using btree (staff_id);

create index idx_staff_documents_type on public.staff_documents using btree (document_type);

create policy "bob_full_read" on "public"."staff_documents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."staff_documents"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "staff_documents_delete" on "public"."staff_documents"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "staff_documents_insert" on "public"."staff_documents"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "staff_documents_select" on "public"."staff_documents"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "staff_documents_update" on "public"."staff_documents"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_documents" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_documents" is 'Uploaded documents for staff — credential evidence, contracts, certificates, policy acknowledgements.';
