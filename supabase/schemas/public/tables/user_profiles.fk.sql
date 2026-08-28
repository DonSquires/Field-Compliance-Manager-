-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."user_profiles"
  add constraint "user_profiles_employer_organization_id_fkey" foreign key (employer_organization_id) references public.organizations(id) on delete set null;

alter table "public"."user_profiles"
  add constraint "user_profiles_organization_id_fkey" foreign key (organization_id) references public.organizations(id);
