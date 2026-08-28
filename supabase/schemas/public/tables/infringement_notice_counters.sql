create table "public"."infringement_notice_counters" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "last_number"     integer                  not null default 0,
  "prefix"          text                     not null default 'INF'::text,
  "updated_at"      timestamp with time zone not null default now(),
  constraint "infringement_notice_counters_organization_id_key" unique (organization_id),
  constraint "infringement_notice_counters_pkey" primary key (id),
  constraint "infringement_notice_counters_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."infringement_notice_counters"
  enable row level security;

create policy "bob_full_read" on "public"."infringement_notice_counters"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "infringement_notice_counters_select" on "public"."infringement_notice_counters"
  for select
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."infringement_notice_counters"
  to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."infringement_notice_counters" is 'Atomic sequential notice number generation per org. Guarantees unique notice numbers.';
