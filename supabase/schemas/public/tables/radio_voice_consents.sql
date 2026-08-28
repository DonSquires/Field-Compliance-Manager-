create table "public"."radio_voice_consents" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "user_id"         uuid                     not null,
  "consented"       boolean                  not null,
  "revoked_at"      timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  constraint "radio_voice_consents_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "radio_voice_consents_pkey" primary key (id),
  constraint "radio_voice_consents_user_id_fkey" foreign key (user_id) references public.user_profiles(id)
);

alter table "public"."radio_voice_consents"
  enable row level security;

create policy "bob_full_read" on "public"."radio_voice_consents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "radio_voice_consents_select" on "public"."radio_voice_consents"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."radio_voice_consents" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."radio_voice_consents" is 'Auditable voice consent records. Consent is required before voice profile registration and is fully revocable.';
