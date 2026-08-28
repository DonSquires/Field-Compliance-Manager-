create table "public"."dev_work_events" (
  "id"              uuid                     not null default gen_random_uuid(),
  "work_request_id" uuid                     not null,
  "run_id"          uuid,
  "event_type"      text                     not null,
  "event_payload"   jsonb                    not null default '{}'::jsonb,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  constraint "dev_work_events_created_by_fkey" foreign key (created_by) references auth.users(id),
  constraint "dev_work_events_pkey" primary key (id),
  constraint "dev_work_events_work_request_id_fkey" foreign key (work_request_id) references public.dev_work_requests(id) on delete cascade,
  constraint "dev_work_events_run_id_fkey" foreign key (run_id) references public.dev_work_runs(id) on delete set null
);

alter table "public"."dev_work_events"
  enable row level security;

create index dev_work_events_run_created_idx on public.dev_work_events using btree (run_id, created_at desc);

create index dev_work_events_wr_created_idx on public.dev_work_events using btree (work_request_id, created_at desc);

create policy "bob_full_read" on "public"."dev_work_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_events"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_work_events" to "anon", "authenticated", "postgres", "service_role";
