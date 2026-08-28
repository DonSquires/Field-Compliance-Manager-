create table "public"."dispatch_job_pay_lines" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "source_dispatch_id" uuid                     not null,
  "officer_user_id"    uuid,
  "rate_rule_id"       uuid,
  "pay_code"           text,
  "rate_type"          text                     not null,
  "description"        text                     not null,
  "quantity"           numeric(12,4)            not null default 1,
  "unit_rate"          numeric(12,4)            not null default 0,
  "multiplier"         numeric(6,4)             not null default 1,
  "line_total"         numeric(12,2)            not null default 0,
  "distance_km"        numeric(10,3),
  "distance_reason"    text,
  "role_code"          text,
  "region_code"        text,
  "service_type"       text,
  "day_category"       text,
  "created_at"         timestamp with time zone not null default now(),
  constraint "dispatch_job_pay_lines_pkey" primary key (id),
  constraint "dispatch_job_pay_lines_source_dispatch_id_fkey" foreign key (source_dispatch_id) references public.dispatch_jobs(id) on delete cascade,
  constraint "dispatch_job_pay_lines_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "dispatch_job_pay_lines_rate_rule_id_fkey" foreign key (rate_rule_id) references public.rate_rules(id) on delete set null,
  constraint "dispatch_job_pay_lines_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id) on delete set null
);

alter table "public"."dispatch_job_pay_lines"
  enable row level security;

create index idx_djpl_dispatch on public.dispatch_job_pay_lines using btree (source_dispatch_id);

create unique index idx_djpl_idempotent_base on public.dispatch_job_pay_lines using btree (organization_id, source_dispatch_id)
  where (pay_code is null);

create unique index idx_djpl_idempotent on public.dispatch_job_pay_lines using btree (organization_id, source_dispatch_id, pay_code)
  where (pay_code is not null);

create index idx_djpl_officer on public.dispatch_job_pay_lines using btree (officer_user_id);

create index idx_djpl_org on public.dispatch_job_pay_lines using btree (organization_id);

create policy "bob_full_read" on "public"."dispatch_job_pay_lines"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "djpl_select" on "public"."dispatch_job_pay_lines"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "djpl_write" on "public"."dispatch_job_pay_lines"
  for all
  to PUBLIC
  using ((public.is_grand_master() or ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) AND (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))
  with check ((public.is_grand_master() OR ((organization_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))) AND (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))));

create policy "gm_full_access" on "public"."dispatch_job_pay_lines"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dispatch_job_pay_lines" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."dispatch_job_pay_lines" is 'Resolved pay/cost lines per completed dispatch job. One row per pay_code per job. Output of resolvePayLines() from rateEngine.ts. Idempotent via partial unique index on (organization_id, source_dispatch_id, pay_code).';
