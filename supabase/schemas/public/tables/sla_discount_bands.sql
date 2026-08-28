create table "public"."sla_discount_bands" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "service_type"        text,
  "over_by_minutes_min" integer                  not null,
  "over_by_minutes_max" integer,
  "discount_pct"        numeric                  not null,
  "created_at"          timestamp with time zone not null default now(),
  constraint "sla_discount_bands_discount_pct_check" check (((discount_pct >= (0)::numeric) AND (discount_pct <= (1)::numeric))),
  constraint "sla_discount_bands_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "sla_discount_bands_pkey" primary key (id)
);

alter table "public"."sla_discount_bands"
  enable row level security;

create index idx_sla_discount_bands_org_svc on public.sla_discount_bands using btree (organization_id, service_type);

create policy "bob_full_read" on "public"."sla_discount_bands"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "sla_discount_bands_select_org" on "public"."sla_discount_bands"
  for select
  to "authenticated"
  using ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."sla_discount_bands" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."sla_discount_bands" is 'Per-org SLA discount bands. over_by_minutes range -> discount_pct. A 100% band (discount_pct=1) = non-billable cutoff. service_type NULL = wildcard (all service types). Epic #226, Phase E billing refinement.';
