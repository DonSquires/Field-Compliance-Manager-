create table "public"."bob_learnings" (
  "id"               uuid                     not null default gen_random_uuid(),
  "learning_key"     text                     not null,
  "title"            text                     not null,
  "learning_text"    text                     not null,
  "learning_type"    text                     not null default 'failure_lesson'::text,
  "learning_status"  text                     not null default 'proposed'::text,
  "source_event_ids" uuid[]                   not null default '{}'::uuid[],
  "source_date"      date                     not null default CURRENT_DATE,
  "reviewed_by"      uuid,
  "reviewed_at"      timestamp with time zone,
  "reviewer_note"    text,
  "created_at"       timestamp with time zone not null default now(),
  "updated_at"       timestamp with time zone not null default now(),
  constraint "bob_learnings_learning_status_check" check ((learning_status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text, 'auto_digest'::text]))),
  constraint "bob_learnings_learning_type_check" check ((learning_type = ANY (ARRAY['failure_lesson'::text, 'success_pattern'::text, 'daily_digest'::text, 'correction'::text]))),
  constraint "bob_learnings_pkey" primary key (id),
  constraint "bob_learnings_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id)
);

alter table "public"."bob_learnings"
  enable row level security;

create index idx_bob_learnings_created_at on public.bob_learnings using btree (created_at desc);

create index idx_bob_learnings_source_date on public.bob_learnings using btree (source_date desc);

create index idx_bob_learnings_status on public.bob_learnings using btree (learning_status);

create index idx_bob_learnings_type on public.bob_learnings using btree (learning_type);

create unique index uniq_bob_learning_key_date on public.bob_learnings using btree (learning_key, source_date);

create policy "bob_full_read" on "public"."bob_learnings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_learnings_select" on "public"."bob_learnings"
  for select
  to PUBLIC
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_learnings" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_learnings" is 'Machine-derived learnings from the daily learning cycle. PROPOSED learnings await human review; APPROVED learnings are durable memory Bob consults via bob_recall_prior_context. AUTO_DIGEST notes are low-risk ephemeral context (pruned after 90 days). Issue #232, epic #228.';
