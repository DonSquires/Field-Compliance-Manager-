create table "public"."provider_client_access_grants" (
  "id"                       uuid                     not null default gen_random_uuid(),
  "service_agreement_id"     uuid                     not null,
  "provider_organization_id" uuid                     not null,
  "client_organization_id"   uuid                     not null,
  "module_key"               text,
  "grant_kind"               text                     not null,
  "starts_at"                timestamp with time zone not null default now(),
  "ends_at"                  timestamp with time zone,
  "created_at"               timestamp with time zone not null default now(),
  constraint "provider_client_access_grants_client_organization_id_fkey" foreign key (client_organization_id) references public.organizations(id),
  constraint "provider_client_access_grants_grant_kind_check" check ((grant_kind = ANY (ARRAY['read'::text, 'write'::text, 'report'::text, 'dispatch'::text, 'admin'::text]))),
  constraint "provider_client_access_grants_pkey" primary key (id),
  constraint "provider_client_access_grants_provider_organization_id_fkey" foreign key (provider_organization_id) references public.organizations(id),
  constraint "provider_client_access_grants_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade
);

alter table "public"."provider_client_access_grants"
  enable row level security;

create policy "bob_full_read" on "public"."provider_client_access_grants"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "provider_client_access_grants_select" on "public"."provider_client_access_grants"
  for select
  to PUBLIC
  using ((public.org_access_allowed(provider_organization_id) or public.org_access_allowed(client_organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."provider_client_access_grants"
  to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."provider_client_access_grants" is 'Explicit provider/client sharing grants. Prevents cross-client data leakage.';
