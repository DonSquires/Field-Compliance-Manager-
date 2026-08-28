create table "public"."staff_biometrics" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "user_id"         uuid                     not null,
  "method"          text                     not null,
  "face_embedding"  jsonb,
  "credential_ref"  text,
  "device_label"    text,
  "enrolled_at"     timestamp with time zone not null default now(),
  "active"          boolean                  not null default true,
  "created_by"      uuid,
  constraint "staff_biometrics_method_check" check ((method = ANY (ARRAY['face'::text, 'device_biometric'::text]))),
  constraint "staff_biometrics_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "staff_biometrics_pkey" primary key (id),
  constraint "staff_biometrics_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "staff_biometrics_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."staff_biometrics"
  enable row level security;

create index idx_staff_biometrics_org on public.staff_biometrics using btree (organization_id);

create unique index uq_staff_biometrics_user_method on public.staff_biometrics using btree (user_id, method)
  where active;

create policy "bob_full_read" on "public"."staff_biometrics"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "staff_biometrics_select" on "public"."staff_biometrics"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_biometrics" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_biometrics" is 'Per-method biometric enrolment for staff (face embedding and/or device credential). Powers the welfare cancel/resolve identity gate and staff face recognition. Service-role written; user_profiles itself stays write-protected. Biometric data is sensitive PII (Privacy Act) — org-scoped, redact before any external call.';
