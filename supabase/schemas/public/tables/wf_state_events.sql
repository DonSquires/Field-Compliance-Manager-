create table "public"."wf_state_events" (
  "id"            bigint                   not null default nextval('public.wf_state_events_id_seq'::regclass),
  "job_id"        uuid                     not null,
  "reason"        text,
  "actor_user_id" uuid,
  "created_at"    timestamp with time zone not null default now(),
  constraint "wf_state_events_actor_user_id_fkey" foreign key (actor_user_id) references auth.users(id),
  constraint "wf_state_events_job_id_fkey" foreign key (job_id) references public.wf_jobs(id) on delete cascade,
  constraint "wf_state_events_pkey" primary key (id)
);

alter table "public"."wf_state_events"
  enable row level security;

alter table "public"."wf_state_events"
  add column "actor_type" public.wf_actor_type not null;

alter table "public"."wf_state_events"
  add column "from_state" public.wf_job_state;

alter table "public"."wf_state_events"
  add column "to_state" public.wf_job_state not null;

create index wf_state_events_job_idx on public.wf_state_events using btree (job_id);

create policy "bob_full_read" on "public"."wf_state_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_state_events_select_policy" on "public"."wf_state_events"
  for select
  to "authenticated"
  using ((exists ( select 1
   from public.wf_jobs j
  where
    ((j.id = wf_state_events.job_id) AND ((j.created_by = ( select auth.uid() as uid)) or ( select public.wf_has_role('verifier'::public.wf_app_role) as wf_has_role) or ( select
    public.wf_has_role('ratifier'::public.wf_app_role) as wf_has_role) or ( select public.wf_has_role('operator'::public.wf_app_role) as wf_has_role))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_state_events" to "anon", "authenticated", "postgres", "service_role";
