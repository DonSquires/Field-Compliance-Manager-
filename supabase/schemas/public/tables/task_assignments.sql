create table "public"."task_assignments" (
  "id"                        uuid                     not null default gen_random_uuid(),
  "user_id"                   uuid                     not null,
  "organization_id"           uuid                     not null,
  "basis"                     text                     not null,
  "observation_id"            uuid,
  "noise_assessment_id"       uuid,
  "smoke_assessment_id"       uuid,
  "biosecurity_assessment_id" uuid,
  "incident_id"               uuid,
  "notice_id"                 uuid,
  "enforcement_case_id"       uuid,
  "started_at"                timestamp with time zone not null default now(),
  "ended_at"                  timestamp with time zone,
  "end_reason"                text,
  "granted_by"                uuid,
  "notes"                     text,
  "created_at"                timestamp with time zone not null default now(),
  "updated_at"                timestamp with time zone not null default now(),
  constraint "chk_one_record" check ((((((((
CASE
    WHEN (observation_id IS NOT NULL) THEN 1
    ELSE 0
END +
CASE
    WHEN (noise_assessment_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (smoke_assessment_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (biosecurity_assessment_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (incident_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (notice_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (enforcement_case_id IS NOT NULL) THEN 1
    ELSE 0
END) = 1)),
  constraint "task_assignments_basis_check" check ((basis = ANY (ARRAY['direct_module_initiation'::text, 'backup_attachment'::text, 'follow_up_ownership'::text]))),
  constraint "task_assignments_biosecurity_assessment_id_fkey" foreign key (biosecurity_assessment_id) references public.biosecurity_assessments(id) on delete cascade,
  constraint "task_assignments_enforcement_case_id_fkey" foreign key (enforcement_case_id) references public.enforcement_cases(id) on delete cascade,
  constraint "task_assignments_incident_id_fkey" foreign key (incident_id) references public.incidents(id) on delete cascade,
  constraint "task_assignments_noise_assessment_id_fkey" foreign key (noise_assessment_id) references public.noise_assessments(id) on delete cascade,
  constraint "task_assignments_notice_id_fkey" foreign key (notice_id) references public.notices(id) on delete cascade,
  constraint "task_assignments_observation_id_fkey" foreign key (observation_id) references public.observations(id) on delete cascade,
  constraint "task_assignments_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "task_assignments_pkey" primary key (id),
  constraint "task_assignments_smoke_assessment_id_fkey" foreign key (smoke_assessment_id) references public.smoke_assessments(id) on delete cascade,
  constraint "task_assignments_granted_by_fkey" foreign key (granted_by) references public.user_profiles(id) on delete set null,
  constraint "task_assignments_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."task_assignments"
  enable row level security;

create index idx_ta_biosecurity on public.task_assignments using btree (biosecurity_assessment_id)
  where (biosecurity_assessment_id is not null);

create index idx_ta_enforcement_case on public.task_assignments using btree (enforcement_case_id)
  where (enforcement_case_id is not null);

create index idx_ta_incident on public.task_assignments using btree (incident_id)
  where (incident_id is not null);

create index idx_ta_noise on public.task_assignments using btree (noise_assessment_id)
  where (noise_assessment_id is not null);

create index idx_ta_notice on public.task_assignments using btree (notice_id)
  where (notice_id is not null);

create index idx_ta_observation on public.task_assignments using btree (observation_id)
  where (observation_id is not null);

create unique index idx_task_assignments_observation_direct_unique
  on public.task_assignments using btree (user_id, observation_id, basis)
  where (observation_id is not null and basis = 'direct_module_initiation');

create index idx_ta_smoke on public.task_assignments using btree (smoke_assessment_id)
  where (smoke_assessment_id is not null);

create index idx_task_assignments_org on public.task_assignments using btree (organization_id);

create index idx_task_assignments_user_live on public.task_assignments using btree (user_id)
  where (ended_at is null);

create trigger trg_task_assignments_touch
  before update on public.task_assignments
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."task_assignments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "task_assignments_insert" on "public"."task_assignments"
  for insert
  to PUBLIC
  with check ((public.org_access_allowed(organization_id) AND ((user_id = auth.uid()) OR public.is_admin_for_org(organization_id))));

create policy "task_assignments_select" on "public"."task_assignments"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) or (user_id = auth.uid())));

create policy "task_assignments_update" on "public"."task_assignments"
  for update
  to PUBLIC
  using ((public.is_admin_for_org(organization_id) or (user_id = auth.uid())))
  with check ((public.is_admin_for_org(organization_id) OR (user_id = auth.uid())));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."task_assignments" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."task_assignments" is 'Situational-entitlement substrate for user_has_task_entitlement (ACCESS_MODEL.md). Logged, time-bounded task-basis records for the signals not on existing columns: direct_module_initiation (claim), backup_attachment, and universal follow_up_ownership. A live basis has ended_at IS NULL; expired rows are retained for audit. Grants ACCESS basis only -- never touches the underlying record. Polymorphic record ref via typed nullable FKs (one-of); extend as the re-anchor worklist grows.';

comment on index "public"."idx_task_assignments_observation_direct_unique" is 'One durable direct-initiation receipt per officer-authored observation; prevents retry duplication while retaining ended basis history.';
