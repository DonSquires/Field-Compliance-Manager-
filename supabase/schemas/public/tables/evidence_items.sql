create table "public"."evidence_items" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "module_key"          text                     not null,
  "evidence_kind"       text                     not null,
  "storage_path"        text,
  "captured_by_user_id" uuid,
  "captured_at"         timestamp with time zone not null default now(),
  "metadata"            jsonb                    not null default '{}'::jsonb,
  constraint "evidence_items_evidence_kind_check" check ((evidence_kind = ANY (ARRAY['photo'::text, 'video'::text, 'audio'::text, 'document'::text, 'note'::text]))),
  constraint "evidence_items_pkey" primary key (id),
  constraint "evidence_items_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "evidence_items_captured_by_user_id_fkey" foreign key (captured_by_user_id) references public.user_profiles(id)
);

alter table "public"."evidence_items"
  enable row level security;

create policy "bob_full_read" on "public"."evidence_items"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "evidence_items_insert" on "public"."evidence_items"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "evidence_items_select" on "public"."evidence_items"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."evidence_items" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."evidence_items" is 'Shared evidence store across all modules. Vehicle, face, ID, document, audio, and note evidence.';
