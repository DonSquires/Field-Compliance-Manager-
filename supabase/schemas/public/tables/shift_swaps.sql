create table "public"."shift_swaps" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "original_shift_id"  uuid                     not null,
  "original_staff_id"  uuid                     not null,
  "swap_with_staff_id" uuid,
  "swap_type"          text                     not null default 'direct'::text,
  "reason"             text,
  "status"             text                     not null default 'pending'::text,
  "requested_by"       uuid                     not null,
  "requested_at"       timestamp with time zone not null default now(),
  "approved_by"        uuid,
  "approved_at"        timestamp with time zone,
  "declined_reason"    text,
  "completed_at"       timestamp with time zone,
  "created_at"         timestamp with time zone not null default now(),
  constraint "shift_swaps_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "shift_swaps_pkey" primary key (id),
  constraint "shift_swaps_status_check" check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'cancelled'::text, 'completed'::text]))),
  constraint "shift_swaps_swap_type_check" check ((swap_type = ANY (ARRAY['direct'::text, 'open'::text, 'coverage_request'::text]))),
  constraint "shift_swaps_original_staff_id_fkey" foreign key (original_staff_id) references public.staff_profiles(id),
  constraint "shift_swaps_swap_with_staff_id_fkey" foreign key (swap_with_staff_id) references public.staff_profiles(id),
  constraint "shift_swaps_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id),
  constraint "shift_swaps_requested_by_fkey" foreign key (requested_by) references public.user_profiles(id)
);

alter table "public"."shift_swaps"
  enable row level security;

create index idx_shift_swaps_org on public.shift_swaps using btree (organization_id);

create index idx_shift_swaps_original_staff on public.shift_swaps using btree (original_staff_id);

create index idx_shift_swaps_status on public.shift_swaps using btree (status);

create index idx_shift_swaps_swap_with on public.shift_swaps using btree (swap_with_staff_id)
  where (swap_with_staff_id is not null);

create policy "bob_full_read" on "public"."shift_swaps"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shift_swaps_insert" on "public"."shift_swaps"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "shift_swaps_select" on "public"."shift_swaps"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "shift_swaps_update" on "public"."shift_swaps"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_swaps" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."shift_swaps" is 'Shift swap requests. Direct swaps, open coverage, or urgent coverage requests. Requires admin approval.';
