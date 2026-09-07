create table "public"."face_observations" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "evidence_item_id" uuid,
  "person_record_id" uuid,
  "confidence"       real,
  "purpose"          text                     not null,
  "review_state"     text                     not null default 'manual_review_required'::text,
  "metadata"         jsonb                    not null default '{}'::jsonb,
  "created_at"       timestamp with time zone not null default now(),
  constraint "face_observations_evidence_item_id_fkey" foreign key (evidence_item_id) references public.evidence_items(id),
  constraint "face_observations_pkey" primary key (id),
  constraint "face_observations_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "face_observations_person_record_id_fkey" foreign key (person_record_id) references public.person_records(id)
);

alter table "public"."face_observations"
  enable row level security;

create policy "bob_full_read" on "public"."face_observations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "face_observations_select" on "public"."face_observations"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."face_observations" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."face_observations" is 'Face inference records. Consequential use requires human review and audit.';
