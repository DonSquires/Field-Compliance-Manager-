create table "public"."dev_work_artifacts" (
  "id"            uuid                     not null default gen_random_uuid(),
  "run_id"        uuid                     not null,
  "artifact_type" text                     not null,
  "storage_path"  text,
  "content_text"  text,
  "content_json"  jsonb,
  "mime_type"     text,
  "created_at"    timestamp with time zone not null default now(),
  constraint "dev_work_artifacts_artifact_type_check"
    check
    ((artifact_type = ANY (ARRAY['diff'::text, 'patch'::text, 'changed_files'::text, 'test_report'::text, 'build_log'::text, 'screenshot'::text, 'mr_link'::text, 'notes'::text,
    'bundle'::text]))),
  constraint "dev_work_artifacts_check" check (((storage_path IS NOT NULL) OR (content_text IS NOT NULL) OR (content_json IS NOT NULL))),
  constraint "dev_work_artifacts_pkey" primary key (id),
  constraint "dev_work_artifacts_run_id_fkey" foreign key (run_id) references public.dev_work_runs(id) on delete cascade
);

alter table "public"."dev_work_artifacts"
  enable row level security;

create index dev_work_artifacts_run_idx on public.dev_work_artifacts using btree (run_id, created_at desc);

create policy "bob_full_read" on "public"."dev_work_artifacts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_artifacts"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_work_artifacts" to "anon", "authenticated", "postgres", "service_role";
