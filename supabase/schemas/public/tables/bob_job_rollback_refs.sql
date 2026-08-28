create table "public"."bob_job_rollback_refs" (
  "id"               uuid                     not null default gen_random_uuid(),
  "job_id"           uuid                     not null,
  "step_id"          text                     not null,
  "tool"             text                     not null,
  "target_table"     text,
  "target_record_id" text,
  "action"           text,
  "reversible"       boolean                  not null default true,
  "reversed"         boolean                  not null default false,
  "reversed_at"      timestamp with time zone,
  "created_at"       timestamp with time zone not null default now(),
  constraint "bob_job_rollback_refs_pkey" primary key (id)
);

alter table "public"."bob_job_rollback_refs"
  enable row level security;

create index idx_bob_job_rollback_job on public.bob_job_rollback_refs using btree (job_id);

create policy "bob_full_read" on "public"."bob_job_rollback_refs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_job_rollback_refs_select" on "public"."bob_job_rollback_refs"
  for select
  to PUBLIC
  using (true);

create policy "bob_job_rollback_refs_write" on "public"."bob_job_rollback_refs"
  for all
  to PUBLIC
  using ((exists ( select 1
   from public.user_profiles up
  where ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text]))))))
  with check ((EXISTS ( SELECT 1
   FROM public.user_profiles up
  WHERE ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text]))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_job_rollback_refs" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_job_rollback_refs" is 'Rollback references for Bob job write steps: which record a step created/updated, so it can be reviewed or reversed.';
