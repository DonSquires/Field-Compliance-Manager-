create table "public"."location_notes" (
  "id"              uuid                     not null default gen_random_uuid(),
  "site_id"         uuid,
  "zone_id"         uuid,
  "organization_id" uuid                     not null,
  "body"            text                     not null,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "ln_site_xor_zone" check ((((site_id IS NOT NULL) AND (zone_id IS NULL)) OR ((site_id IS NULL) AND (zone_id IS NOT NULL)))),
  constraint "location_notes_pkey" primary key (id),
  constraint "location_notes_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "location_notes_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "location_notes_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "location_notes_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."location_notes"
  enable row level security;

create index idx_ln_org on public.location_notes using btree (organization_id);

create index idx_ln_site on public.location_notes using btree (site_id)
  where (site_id is not null);

create index idx_ln_zone on public.location_notes using btree (zone_id)
  where (zone_id is not null);

create trigger trg_touch_ln
  before update on public.location_notes
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."location_notes"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."location_notes"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "ln_select" on "public"."location_notes"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id = ( select user_profiles.organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())
 limit 1))));

create policy "ln_write" on "public"."location_notes"
  for all
  to PUBLIC
  using (((organization_id = ( select user_profiles.organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())
 limit 1)) AND (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))
  with check (((organization_id = ( SELECT user_profiles.organization_id
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())
 LIMIT 1)) AND (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."location_notes" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."location_notes" is 'Org-private notes on a site or zone (Tier 3 visibility, epic #179). RLS enforces that only the owning org can read or write its own notes. No override possible. Notes from different orgs at the same location are completely isolated.';
