create table "public"."ptt_channels" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "name"              text                     not null,
  "emergency_enabled" boolean                  not null default true,
  "created_at"        timestamp with time zone not null default now(),
  constraint "ptt_channels_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "ptt_channels_pkey" primary key (id)
);

alter table "public"."ptt_channels"
  enable row level security;

create policy "bob_full_read" on "public"."ptt_channels"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ptt_channels_insert" on "public"."ptt_channels"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "ptt_channels_select" on "public"."ptt_channels"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ptt_channels_update" on "public"."ptt_channels"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."ptt_channels" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."ptt_channels" is 'PTT radio channels per organisation. Emergency broadcast is enabled by default.';
