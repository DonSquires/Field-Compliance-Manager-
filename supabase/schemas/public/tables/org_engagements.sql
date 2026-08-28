create table "public"."org_engagements" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "from_org_id"          uuid                     not null,
  "to_org_id"            uuid                     not null,
  "engagement_type"      text                     not null,
  "status"               text                     not null default 'active'::text,
  "starts_on"            date,
  "ends_on"              date,
  "service_agreement_id" uuid,
  "notes"                text,
  "created_at"           timestamp with time zone not null default now(),
  constraint "org_engagements_engagement_type_check" check ((engagement_type = ANY (ARRAY['organisation_engages_provider'::text, 'contractor_subcontracts_branch'::text]))),
  constraint "org_engagements_from_org_id_to_org_id_engagement_type_key" unique (from_org_id, to_org_id, engagement_type),
  constraint "org_engagements_pkey" primary key (id),
  constraint "org_engagements_status_check" check ((status = ANY (ARRAY['active'::text, 'ended'::text]))),
  constraint "org_engagements_from_org_id_fkey" foreign key (from_org_id) references public.organizations(id) on delete cascade,
  constraint "org_engagements_to_org_id_fkey" foreign key (to_org_id) references public.organizations(id) on delete cascade,
  constraint "org_engagements_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete set null
);

alter table "public"."org_engagements"
  enable row level security;

create index idx_org_engagements_from on public.org_engagements using btree (from_org_id);

create index idx_org_engagements_to on public.org_engagements using btree (to_org_id);

create policy "bob_full_read" on "public"."org_engagements"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."org_engagements"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "org_engagements_select" on "public"."org_engagements"
  for select
  to PUBLIC
  using (((from_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) or (to_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "org_engagements_write" on "public"."org_engagements"
  for all
  to PUBLIC
  using (((from_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) or (to_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))))
  with check (((from_org_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))) OR (to_org_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid())))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."org_engagements" to "anon", "authenticated", "postgres", "service_role";
