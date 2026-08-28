create table "public"."onboarding_invites" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "target_organization_id" uuid                     not null,
  "service_agreement_id"   uuid,
  "invited_by"             uuid,
  "email"                  text                     not null,
  "token_hash"             text                     not null,
  "status"                 text                     not null default 'pending'::text,
  "created_at"             timestamp with time zone not null default now(),
  "expires_at"             timestamp with time zone not null,
  "accepted_at"            timestamp with time zone,
  "declined_at"            timestamp with time zone,
  constraint "onboarding_invites_invited_by_fkey" foreign key (invited_by) references auth.users(id) on delete set null,
  constraint "onboarding_invites_pkey" primary key (id),
  constraint "onboarding_invites_status_check" check ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'revoked'::text]))),
  constraint "onboarding_invites_target_organization_id_fkey" foreign key (target_organization_id) references public.organizations(id),
  constraint "onboarding_invites_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id)
);

alter table "public"."onboarding_invites"
  enable row level security;

create index idx_onboarding_invites_agreement on public.onboarding_invites using btree (service_agreement_id)
  where (service_agreement_id is not null);

create index idx_onboarding_invites_target_org on public.onboarding_invites using btree (target_organization_id);

create unique index uq_onboarding_invites_one_active_per_org on public.onboarding_invites using btree (target_organization_id)
  where (status = 'pending'::text);

create unique index uq_onboarding_invites_token_hash on public.onboarding_invites using btree (token_hash);

create trigger trg_sync_invitation_status
  after insert or update on public.onboarding_invites
  for each row
  execute function public.sync_invitation_status();

create policy "bob_full_read" on "public"."onboarding_invites"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "onboarding_invites_insert" on "public"."onboarding_invites"
  for insert
  to "authenticated"
  with check ((public.is_grand_master() OR (EXISTS ( SELECT 1
   FROM public.user_profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['master'::text, 'grand_master'::text])))))));

create policy "onboarding_invites_select" on "public"."onboarding_invites"
  for select
  to "authenticated"
  using ((public.is_grand_master() or public.org_access_allowed(target_organization_id) or (exists ( select 1
   from public.user_profiles inviter_profile
  where ((inviter_profile.id = onboarding_invites.invited_by) AND public.org_access_allowed(inviter_profile.organization_id))))));

create policy "onboarding_invites_update" on "public"."onboarding_invites"
  for update
  to "authenticated"
  using ((public.is_grand_master() or (invited_by = auth.uid())))
  with check ((public.is_grand_master() OR (invited_by = auth.uid())));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."onboarding_invites" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."onboarding_invites" is 'Invitation lifecycle for org onboarding (#361). Source of truth for invite state. Token stored as SHA-256 hash, never plaintext. The derived invitation_status on service_agreements is a read-optimised denormalisation for the CRM page.';
