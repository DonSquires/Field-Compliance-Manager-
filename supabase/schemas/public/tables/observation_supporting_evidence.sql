create table "public"."observation_supporting_evidence" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "observation_id"       uuid,
  "overnight_session_id" uuid,
  "evidence_kind"        text                     not null,
  "storage_bucket"       text                     not null default 'scans'::text,
  "storage_path"         text,
  "notes"                text,
  "captured_at"          timestamp with time zone not null default now(),
  "gps_lat"              double precision,
  "gps_lng"              double precision,
  "created_by"           uuid,
  "created_at"           timestamp with time zone not null default now(),
  constraint "observation_supporting_evidence_evidence_kind_check"
    check ((evidence_kind = ANY (ARRAY['scv_sticker'::text, 'signage'::text, 'permit'::text, 'vehicle_detail'::text, 'scene_context'::text, 'other'::text]))),
  constraint "observation_supporting_evidence_pkey" primary key (id),
  constraint "observation_supporting_evidence_observation_id_fkey" foreign key (observation_id) references public.observations(id) on delete cascade,
  constraint "observation_supporting_evidence_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "observation_supporting_evidence_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "observation_supporting_evidence_overnight_session_id_fkey" foreign key (overnight_session_id) references public.vehicle_overnight_sessions(id) on delete set null
);

alter table "public"."observation_supporting_evidence"
  enable row level security;

create index idx_observation_supporting_evidence_observation on public.observation_supporting_evidence using btree (observation_id, captured_at desc);

create index idx_observation_supporting_evidence_session on public.observation_supporting_evidence using btree (overnight_session_id, captured_at desc);

create policy "bob_full_read" on "public"."observation_supporting_evidence"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "observation_supporting_evidence_insert" on "public"."observation_supporting_evidence"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "observation_supporting_evidence_select" on "public"."observation_supporting_evidence"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "observation_supporting_evidence_update" on "public"."observation_supporting_evidence"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."observation_supporting_evidence"
  to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."observation_supporting_evidence" is 'Supporting detail-scan evidence linked to observations or overnight sessions.';
