create table "public"."reference_codes" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "code_type"       text                     not null,
  "code"            text                     not null,
  "name"            text                     not null,
  "description"     text,
  "item_category"   text,
  "unit"            text,
  "default_rate"    numeric,
  "region_code"     text,
  "service_type"    text,
  "parent_code"     text,
  "is_active"       boolean                  not null default true,
  "sort_order"      integer                  not null default 0,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "created_by"      uuid,
  "updated_by"      uuid,
  "external_refs"   jsonb                    not null default '{}'::jsonb,
  constraint "reference_codes_code_type_check"
    check ((code_type = ANY (ARRAY['pay_item'::text, 'gl_account'::text, 'role_code'::text, 'job_code'::text, 'branch'::text, 'org_code'::text, 'service_code'::text]))),
  constraint "reference_codes_item_category_check"
    check
    (((item_category IS NULL) OR (item_category = ANY (ARRAY['earning'::text, 'allowance'::text, 'leave'::text, 'reimbursement'::text, 'oncall'::text, 'overhead'::text,
    'penalty'::text])))),
  constraint "reference_codes_organization_id_code_type_code_key" unique (organization_id, code_type, code),
  constraint "reference_codes_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "reference_codes_pkey" primary key (id),
  constraint "reference_codes_unit_check"
    check (((unit IS NULL) OR (unit = ANY (ARRAY['hour'::text, 'km'::text, 'flat'::text, 'block'::text, 'percentage'::text, 'unit'::text, 'visit'::text])))),
  constraint "reference_codes_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "reference_codes_updated_by_fkey" foreign key (updated_by) references public.user_profiles(id) on delete set null
);

alter table "public"."reference_codes"
  enable row level security;

create index idx_refcodes_active on public.reference_codes using btree (organization_id, code_type, is_active);

create unique index idx_refcodes_org_code_unique on public.reference_codes using btree (code)
  where (code_type = 'org_code'::text);

create index idx_refcodes_org on public.reference_codes using btree (organization_id);

create unique index idx_refcodes_service_code_per_branch on public.reference_codes using btree (organization_id, parent_code, code)
  where (code_type = 'service_code'::text);

create index idx_refcodes_type on public.reference_codes using btree (organization_id, code_type);

create trigger trg_reference_codes_touch
  before update on public.reference_codes
  for each row
  execute function public.tg_reference_codes_touch();

create policy "bob_full_read" on "public"."reference_codes"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "refcodes_select" on "public"."reference_codes"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "refcodes_write" on "public"."reference_codes"
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

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."reference_codes" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."reference_codes"."external_refs" is 'Legacy external system identifiers (Wilsar/Deputy branch numbers, payroll codes). Boundary mappings only — never used as the human-readable code (ruling 7B). Same pattern as 0167 external_refs on client_sites/location_zones.';
