create table "public"."person_records" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "display_name"    text,
  "review_state"    text                     not null default 'draft'::text,
  "metadata"        jsonb                    not null default '{}'::jsonb,
  "created_at"      timestamp with time zone not null default now(),
  constraint "person_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "person_records_pkey" primary key (id),
  constraint "person_records_review_state_check" check ((review_state = ANY (ARRAY['draft'::text, 'verified'::text, 'rejected'::text, 'manual_review_required'::text])))
);

alter table "public"."person_records"
  enable row level security;

create policy "bob_full_read" on "public"."person_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "person_records_select" on "public"."person_records"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."person_records" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."person_records" is 'Master person registry. Draft records require human review before enforcement use.';
