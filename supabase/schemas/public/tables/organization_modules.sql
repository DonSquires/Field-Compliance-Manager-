create table "public"."organization_modules" (
  "id"              uuid    not null default gen_random_uuid(),
  "organization_id" uuid    not null,
  "module_key"      text    not null,
  "enabled"         boolean not null default true,
  "settings"        jsonb   not null default '{}'::jsonb,
  constraint "organization_modules_organization_id_module_key_key" unique (organization_id, module_key),
  constraint "organization_modules_pkey" primary key (id),
  constraint "organization_modules_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."organization_modules"
  enable row level security;

create trigger trg_align_module_subscription
  after insert or update of enabled on public.organization_modules
  for each row
  execute function public.tg_align_module_subscription();

create policy "bob_full_read" on "public"."organization_modules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "organization_modules_delete" on "public"."organization_modules"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "organization_modules_insert" on "public"."organization_modules"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "organization_modules_select" on "public"."organization_modules"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "organization_modules_update" on "public"."organization_modules"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."organization_modules" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."organization_modules" is 'Optional module enablement per organisation. Controls which features are available.';
