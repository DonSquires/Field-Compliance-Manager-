create table "public"."bob_messages" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "conversation_id" uuid                     not null,
  "role"            text                     not null,
  "content"         text                     not null,
  "confidence"      real,
  "flagged"         boolean                  not null default false,
  "created_at"      timestamp with time zone not null default now(),
  "metadata"        jsonb                    not null default '{}'::jsonb,
  constraint "bob_messages_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete cascade,
  constraint "bob_messages_pkey" primary key (id),
  constraint "bob_messages_role_check" check ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]))),
  constraint "bob_messages_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."bob_messages"
  enable row level security;

create policy "bob_full_read" on "public"."bob_messages"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_messages_insert" on "public"."bob_messages"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_messages_select" on "public"."bob_messages"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_messages" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_messages"."metadata" is 'Per-turn conductor metadata (intent, planned_tool, questions, proposed_entities, suggested_action, confidence). Powers Bob cross-turn resume/pending in onspace-ai-chat loadHistory. Added 0131 after the column was found missing live, which had silently broken chat persistence.';

comment on table "public"."bob_messages" is 'Individual Bob AI messages within a conversation. Includes confidence and hallucination flag.';
