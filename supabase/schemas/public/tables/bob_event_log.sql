create table "public"."bob_event_log" (
  "id"              uuid                     not null default gen_random_uuid(),
  "conversation_id" uuid                     not null,
  "organization_id" uuid                     not null,
  "user_id"         uuid                     not null,
  "turn_index"      integer                  not null,
  "step_index"      integer                  not null,
  "event_type"      text                     not null,
  "tool"            text,
  "outcome"         text,
  "step_payload"    jsonb                    not null default '{}'::jsonb,
  "response_id"     text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "bob_event_log_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete cascade,
  constraint "bob_event_log_pkey" primary key (id),
  constraint "bob_event_log_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_event_log_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."bob_event_log"
  enable row level security;

create index idx_bob_event_log_conversation on public.bob_event_log using btree (conversation_id, turn_index, step_index);

create index idx_bob_event_log_org on public.bob_event_log using btree (organization_id);

create index idx_bob_event_log_response_id on public.bob_event_log using btree (response_id)
  where (response_id is not null);

create policy "bob_event_log_insert" on "public"."bob_event_log"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_event_log_select" on "public"."bob_event_log"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_event_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_event_log" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_event_log" is 'Structured per-step event log for the Bob conductor reasoning loop. Append-only; one row per discrete conductor step. Pillar H of the Bob Redesign (#135/#143).';
