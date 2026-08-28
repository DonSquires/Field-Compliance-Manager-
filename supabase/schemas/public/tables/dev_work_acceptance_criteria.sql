create table "public"."dev_work_acceptance_criteria" (
  "id"              uuid                     not null default gen_random_uuid(),
  "work_request_id" uuid                     not null,
  "criterion_text"  text                     not null,
  "sort_order"      integer                  not null default 0,
  "is_required"     boolean                  not null default true,
  "created_at"      timestamp with time zone not null default now(),
  constraint "dev_work_acceptance_criteria_pkey" primary key (id),
  constraint "dev_work_acceptance_criteria_work_request_id_fkey" foreign key (work_request_id) references public.dev_work_requests(id) on delete cascade
);

alter table "public"."dev_work_acceptance_criteria"
  enable row level security;

create index dev_work_acceptance_criteria_wr_idx on public.dev_work_acceptance_criteria using btree (work_request_id, sort_order);

create policy "bob_full_read" on "public"."dev_work_acceptance_criteria"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_work_acceptance_criteria"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."dev_work_acceptance_criteria"
  to "anon", "authenticated", "postgres", "service_role";
