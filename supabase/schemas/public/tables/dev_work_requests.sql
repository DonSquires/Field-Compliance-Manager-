create table "public"."dev_work_requests" (
  "id"              uuid                     not null default gen_random_uuid(),
  "title"           text                     not null,
  "goal"            text                     not null,
  "description"     text,
  "request_type"    text                     not null,
  "target_area"     text,
  "risk_tier"       text                     not null,
  "status"          text                     not null,
  "requested_by"    uuid,
  "assigned_runner" text,
  "execution_host"  text                     not null default 'hpanel'::text,
  "source_repo"     text,
  "target_branch"   text,
  "draft_branch"    text,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "verified_at"     timestamp with time zone,
  "ratified_at"     timestamp with time zone,
  "promoted_at"     timestamp with time zone,
  constraint "dev_work_requests_pkey" primary key (id),
  constraint "dev_work_requests_request_type_check"
    check ((request_type = ANY (ARRAY['feature'::text, 'bugfix'::text, 'refactor'::text, 'design'::text, 'review'::text, 'ops'::text]))),
  constraint "dev_work_requests_requested_by_fkey" foreign key (requested_by) references auth.users(id),
  constraint "dev_work_requests_risk_tier_check" check ((risk_tier = ANY (ARRAY['tier_1'::text, 'tier_2'::text, 'tier_3'::text]))),
  constraint "dev_work_requests_status_check"
    check
    ((status = ANY (ARRAY['draft'::text, 'verified'::text, 'queued'::text, 'running'::text, 'awaiting_ratification'::text, 'approved'::text, 'rejected'::text,
    'promotion_pending'::text, 'promoted'::text, 'failed'::text, 'cancelled'::text])))
);

alter table "public"."dev_work_requests"
  enable row level security;

create index dev_work_requests_created_at_idx on public.dev_work_requests using btree (created_at desc);

create index dev_work_requests_requested_by_idx on public.dev_work_requests using btree (requested_by);

create index dev_work_requests_status_idx on public.dev_work_requests using btree (status);

create trigger trg_dev_work_requests_set_updated_at
  before update on public.dev_work_requests
  for each row
  execute function public.dev_work_requests_set_updated_at();

create policy "bob_full_read" on "public"."dev_work_requests"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_requests"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_work_requests" to "anon", "authenticated", "postgres", "service_role";
