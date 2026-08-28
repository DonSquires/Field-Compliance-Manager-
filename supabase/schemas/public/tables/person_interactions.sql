create table "public"."person_interactions" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "person_id"         uuid                     not null,
  "officer_user_id"   uuid,
  "interaction_type"  text                     not null,
  "notes"             text,
  "location_id"       uuid,
  "evidence_id"       uuid,
  "interacted_at"     timestamp with time zone not null default now(),
  "client_site_id"    uuid,
  "zone_id"           uuid,
  "location_event_id" uuid,
  constraint "person_interactions_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete set null,
  constraint "person_interactions_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id),
  constraint "person_interactions_location_event_id_fkey" foreign key (location_event_id) references public.location_events(id) on delete set null,
  constraint "person_interactions_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "person_interactions_pkey" primary key (id),
  constraint "person_interactions_place_anchor_present_chk" check (((location_id IS NOT NULL) OR (client_site_id IS NOT NULL) OR (zone_id IS NOT NULL))),
  constraint "person_interactions_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete set null,
  constraint "person_interactions_person_id_fkey" foreign key (person_id) references public.persons(id),
  constraint "person_interactions_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."person_interactions"
  enable row level security;

create index idx_person_interactions_client_site on public.person_interactions using btree (client_site_id);

create index idx_person_interactions_location_event on public.person_interactions using btree (location_event_id);

create index idx_person_interactions_zone on public.person_interactions using btree (zone_id);

create index person_interactions_location_idx on public.person_interactions using btree (location_id);

create policy "bob_full_read" on "public"."person_interactions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "person_interactions_select" on "public"."person_interactions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."person_interactions" to "anon", "authenticated", "postgres", "service_role";

comment on constraint "person_interactions_place_anchor_present_chk" on "public"."person_interactions" is 'Nothing-orphaned guard (from 0103 intent): at least one of location_id (legacy) / client_site_id / zone_id must be set. Flexible anchor — not a hard XOR — while `locations` remains valid during the staged retire (#7).';

comment on table "public"."person_interactions" is 'Officer interaction history with a known person.';
