create table "public"."incident_attachments" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "incident_id"      uuid                     not null,
  "evidence_item_id" uuid,
  "attachment_kind"  text                     not null,
  "created_at"       timestamp with time zone not null default now(),
  constraint "incident_attachments_attachment_kind_check" check ((attachment_kind = ANY (ARRAY['photo'::text, 'video'::text, 'audio'::text, 'document'::text, 'note'::text]))),
  constraint "incident_attachments_evidence_item_id_fkey" foreign key (evidence_item_id) references public.evidence_items(id),
  constraint "incident_attachments_pkey" primary key (id),
  constraint "incident_attachments_incident_id_fkey" foreign key (incident_id) references public.incidents(id) on delete cascade,
  constraint "incident_attachments_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."incident_attachments"
  enable row level security;

create policy "bob_full_read" on "public"."incident_attachments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "incident_attachments_select" on "public"."incident_attachments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."incident_attachments" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."incident_attachments" is 'Evidence attached to field incidents.';
