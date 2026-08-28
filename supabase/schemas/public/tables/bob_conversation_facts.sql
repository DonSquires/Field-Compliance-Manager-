create table "public"."bob_conversation_facts" (
  "id"              uuid                     not null default gen_random_uuid(),
  "conversation_id" uuid                     not null,
  "organization_id" uuid                     not null,
  "schema_version"  integer                  not null default 1,
  "active_slot"     text,
  "slots"           jsonb                    not null default '{}'::jsonb,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "bob_conversation_facts_conversation_id_key" unique (conversation_id),
  constraint "bob_conversation_facts_pkey" primary key (id),
  constraint "bob_conversation_facts_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete cascade,
  constraint "bob_conversation_facts_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."bob_conversation_facts"
  enable row level security;

create index idx_bob_conversation_facts_conversation on public.bob_conversation_facts using btree (conversation_id);

create index idx_bob_conversation_facts_org on public.bob_conversation_facts using btree (organization_id);

create policy "bob_conversation_facts_insert" on "public"."bob_conversation_facts"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_conversation_facts_select" on "public"."bob_conversation_facts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_conversation_facts_update" on "public"."bob_conversation_facts"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_conversation_facts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_conversation_facts" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_conversation_facts"."active_slot" is 'Key of the currently active slot in the slots JSONB. Null if no slot is active.';

comment on column "public"."bob_conversation_facts"."conversation_id" is 'The conversation this facts row belongs to. One-to-one with bob_conversations.';

comment on column "public"."bob_conversation_facts"."organization_id" is 'Org scope — denormalised from bob_conversations for RLS. Must match the conversation''s org.';

comment on column "public"."bob_conversation_facts"."schema_version" is 'Schema version for the slots JSONB structure. Allows non-breaking evolution of slot shape.';

comment on column "public"."bob_conversation_facts"."slots" is 'JSONB object keyed by slot name (e.g. ''branch_regulatory_services'', ''zone_kinzet''). Each value contains kind, status, facts, resolved_ids, and source_history.';

comment on table "public"."bob_conversation_facts" is 'Structured working memory for Bob conversations. One row per conversation, with a JSONB slots column holding multiple concurrent named entity slots. Pillar A of the Bob Redesign (#135/#136).';
