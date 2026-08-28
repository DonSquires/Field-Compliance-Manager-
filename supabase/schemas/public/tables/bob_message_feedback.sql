create table "public"."bob_message_feedback" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "conversation_id" uuid                     not null,
  "message_id"      uuid                     not null,
  "user_id"         uuid                     not null,
  "rating"          text                     not null,
  "note"            text,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "bob_message_feedback_conversation_id_fkey" foreign key (conversation_id) references public.bob_conversations(id) on delete cascade,
  constraint "bob_message_feedback_pkey" primary key (id),
  constraint "bob_message_feedback_rating_check" check ((rating = ANY (ARRAY['up'::text, 'down'::text]))),
  constraint "uq_bob_message_feedback_user_message" unique (message_id, user_id),
  constraint "bob_message_feedback_message_id_fkey" foreign key (message_id) references public.bob_messages(id) on delete cascade,
  constraint "bob_message_feedback_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_message_feedback_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."bob_message_feedback"
  enable row level security;

create index idx_bob_message_feedback_conversation on public.bob_message_feedback using btree (conversation_id);

create index idx_bob_message_feedback_message on public.bob_message_feedback using btree (message_id);

create index idx_bob_message_feedback_org on public.bob_message_feedback using btree (organization_id);

create index idx_bob_message_feedback_rating on public.bob_message_feedback using btree (organization_id, rating);

create trigger trg_bob_message_feedback_updated_at
  before update on public.bob_message_feedback
  for each row
  execute function public.set_bob_message_feedback_updated_at();

create policy "bob_full_read" on "public"."bob_message_feedback"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_message_feedback_delete" on "public"."bob_message_feedback"
  for delete
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND (user_id = auth.uid())));

create policy "bob_message_feedback_insert" on "public"."bob_message_feedback"
  for insert
  to PUBLIC
  with check ((public.org_access_allowed(organization_id) AND (user_id = auth.uid())));

create policy "bob_message_feedback_select" on "public"."bob_message_feedback"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((user_id = auth.uid()) or public.is_admin_for_org(organization_id))));

create policy "bob_message_feedback_update" on "public"."bob_message_feedback"
  for update
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND (user_id = auth.uid())))
  with check ((public.org_access_allowed(organization_id) AND (user_id = auth.uid())));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_message_feedback" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_message_feedback" is 'Per-message like/dislike on Bob replies (BobPanel). One row per (message,user); optional note for dislikes. Admins read org-wide for feedback triage.';
