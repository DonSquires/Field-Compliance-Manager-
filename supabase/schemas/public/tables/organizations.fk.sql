-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

alter table "public"."organizations"
  add constraint "organizations_corporate_profile_verified_by_fkey" foreign key (corporate_profile_verified_by) references public.user_profiles(id) on delete set null;

alter table "public"."organizations"
  add constraint "organizations_jurisdiction_verified_by_fkey" foreign key (jurisdiction_verified_by) references public.user_profiles(id);
