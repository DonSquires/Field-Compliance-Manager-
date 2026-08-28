create table "public"."staff_training_records" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "staff_id"        uuid,
  "officer_id"      uuid,
  "training_name"   text                     not null,
  "training_type"   text                     not null default 'internal'::text,
  "provider"        text,
  "completed_date"  date                     not null,
  "expiry_date"     date,
  "passed"          boolean,
  "score"           numeric,
  "notes"           text,
  "recorded_by"     uuid,
  "created_at"      timestamp with time zone not null default now(),
  constraint "staff_training_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "staff_training_records_pkey" primary key (id),
  constraint "staff_training_records_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade,
  constraint "staff_training_records_training_type_check"
    check ((training_type = ANY (ARRAY['internal'::text, 'external'::text, 'online'::text, 'certification'::text, 'induction'::text]))),
  constraint "staff_training_records_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id) on delete set null,
  constraint "staff_training_records_recorded_by_fkey" foreign key (recorded_by) references public.user_profiles(id) on delete set null
);

alter table "public"."staff_training_records"
  enable row level security;

create index idx_str_expiry on public.staff_training_records using btree (expiry_date);

create index idx_str_officer on public.staff_training_records using btree (officer_id);

create index idx_str_org on public.staff_training_records using btree (organization_id);

create index idx_str_staff on public.staff_training_records using btree (staff_id);

create policy "bob_full_read" on "public"."staff_training_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "str_select" on "public"."staff_training_records"
  for select
  to PUBLIC
  using ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))));

create policy "str_write" on "public"."staff_training_records"
  for all
  to PUBLIC
  using (((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) AND (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text]))))
  with check ((organization_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_training_records" to "anon", "authenticated", "postgres", "service_role";
