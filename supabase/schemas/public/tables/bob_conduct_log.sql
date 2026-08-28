create table "public"."bob_conduct_log" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "subject_user_id" uuid,
  "area"            text                     not null,
  "valence"         text                     not null,
  "what"            text                     not null,
  "reason"          text,
  "method_lesson"   text,
  "redo_ref"        text,
  "source_kind"     text,
  "source_ref"      text,
  "status"          text                     not null default 'confirmed'::text,
  "judged_by"       uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "bob_conduct_log_area_check" check ((area = ANY (ARRAY['chore'::text, 'interaction'::text, 'communication'::text]))),
  constraint "bob_conduct_log_pkey" primary key (id),
  constraint "bob_conduct_log_source_kind_check"
    check ((source_kind = ANY (ARRAY['agentic_action'::text, 'message_feedback'::text, 'reversal'::text, 'human_note'::text, 'self_assessment'::text]))),
  constraint "bob_conduct_log_status_check" check ((status = ANY (ARRAY['proposed'::text, 'confirmed'::text]))),
  constraint "bob_conduct_log_valence_check" check ((valence = ANY (ARRAY['reward'::text, 'correction'::text]))),
  constraint "bob_conduct_log_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_conduct_log_judged_by_fkey" foreign key (judged_by) references public.user_profiles(id) on delete set null,
  constraint "bob_conduct_log_subject_user_id_fkey" foreign key (subject_user_id) references public.user_profiles(id) on delete set null
);

alter table "public"."bob_conduct_log"
  enable row level security;

create index idx_bob_conduct_log_area_valence on public.bob_conduct_log using btree (area, valence);

create index idx_bob_conduct_log_org on public.bob_conduct_log using btree (organization_id);

create index idx_bob_conduct_log_status on public.bob_conduct_log using btree (status)
  where (status = 'proposed'::text);

create index idx_bob_conduct_log_subject on public.bob_conduct_log using btree (subject_user_id, created_at desc);

create trigger trg_bob_conduct_log_updated_at
  before update on public.bob_conduct_log
  for each row
  execute function public.set_bob_conduct_log_updated_at();

create policy "bob_conduct_log_insert" on "public"."bob_conduct_log"
  for insert
  to PUBLIC
  with check (((organization_id IS NOT NULL) AND public.org_access_allowed(organization_id) AND public.is_admin_for_org(organization_id)));

create policy "bob_conduct_log_select" on "public"."bob_conduct_log"
  for select
  to PUBLIC
  using (((organization_id is null) or (public.org_access_allowed(organization_id) AND ((subject_user_id = auth.uid()) or public.is_admin_for_org(organization_id)))));

create policy "bob_conduct_log_update" on "public"."bob_conduct_log"
  for update
  to PUBLIC
  using (((organization_id is not null) AND public.org_access_allowed(organization_id) AND public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NOT NULL) AND public.org_access_allowed(organization_id) AND public.is_admin_for_org(organization_id)));

create policy "bob_full_read" on "public"."bob_conduct_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_conduct_log" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_conduct_log"."method_lesson" is 'The METHOD taught/reinforced so it generalises — never the specific answer (teach, do not cheat).';

comment on column "public"."bob_conduct_log"."status" is 'proposed = Bob-proposed self-assessment awaiting human confirmation; confirmed = human authored/confirmed. Bob never unilaterally scores himself.';

comment on column "public"."bob_conduct_log"."valence" is 'reward | correction only. There is deliberately no punishment value (positive-reinforcement principle). Honest uncertainty / asking-at-a-fork is recorded as a reward.';

comment on table "public"."bob_conduct_log" is 'Bob conduct/consequence record (#20). Positive reinforcement: valence reward|correction (no punishment). Four-part shape: what/reason/method_lesson/redo_ref. Human is the judge (judged_by); Bob self-assessments stay status=proposed until confirmed. Signals read from bob_message_feedback + bob_agentic_actions; conduct written here. Scope-1 per subject_user_id; organization_id null = platform/character-level.';
