create table "public"."notice_counters" (
  "id"              uuid    not null default gen_random_uuid(),
  "organization_id" uuid    not null,
  "notice_type"     text    not null,
  "prefix"          text    not null,
  "last_number"     integer not null default 0,
  constraint "notice_counters_organization_id_notice_type_key" unique (organization_id, notice_type),
  constraint "notice_counters_pkey" primary key (id),
  constraint "notice_counters_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."notice_counters"
  enable row level security;

create policy "bob_full_read" on "public"."notice_counters"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "notice_counters_select" on "public"."notice_counters"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."notice_counters" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."notice_counters" is 'Atomic sequential notice number generation per org and notice type.';
