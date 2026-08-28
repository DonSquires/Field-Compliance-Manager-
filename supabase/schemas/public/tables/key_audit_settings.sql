create table "public"."key_audit_settings" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "is_enabled"             boolean                  not null default true,
  "audit_frequency_days"   integer                  not null default 14,
  "require_shift_handover" boolean                  not null default true,
  "created_at"             timestamp with time zone not null default now(),
  constraint "key_audit_settings_pkey" primary key (id),
  constraint "key_audit_settings_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."key_audit_settings"
  enable row level security;

create policy "bob_full_read" on "public"."key_audit_settings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "key_audit_settings_select" on "public"."key_audit_settings"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."key_audit_settings" to "anon", "authenticated", "postgres", "service_role";
