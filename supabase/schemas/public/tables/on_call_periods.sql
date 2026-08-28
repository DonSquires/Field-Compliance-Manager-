create table "public"."on_call_periods" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "officer_user_id" uuid                     not null,
  "period_type"     text                     not null,
  "starts_at"       timestamp with time zone not null,
  "ends_at"         timestamp with time zone not null,
  "flat_rate"       numeric(10,2),
  "linked_shift_id" uuid,
  "status"          text                     not null default 'pending'::text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "on_call_periods_period_type_check" check ((period_type = ANY (ARRAY['standard'::text, 'before_shift'::text, 'after_shift'::text, 'overnight'::text]))),
  constraint "on_call_periods_pkey" primary key (id),
  constraint "on_call_periods_status_check" check ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'completed'::text]))),
  constraint "on_call_periods_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "on_call_periods_linked_shift_id_fkey" foreign key (linked_shift_id) references public.shifts(id),
  constraint "on_call_periods_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."on_call_periods"
  enable row level security;

create policy "bob_full_read" on "public"."on_call_periods"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."on_call_periods"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "on_call_periods_delete" on "public"."on_call_periods"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "on_call_periods_insert" on "public"."on_call_periods"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "on_call_periods_select" on "public"."on_call_periods"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "on_call_periods_update" on "public"."on_call_periods"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."on_call_periods" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."on_call_periods" is 'On-call availability assignments. Officers receive flat rate and minimum 3hr pay when called out.';
