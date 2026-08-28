create table "public"."wf_user_roles" (
  "user_id"    uuid                     not null,
  "created_at" timestamp with time zone not null default now(),
  constraint "wf_user_roles_user_id_fkey" foreign key (user_id) references auth.users(id) on delete cascade
);

alter table "public"."wf_user_roles"
  enable row level security;

alter table "public"."wf_user_roles"
  add column "role" public.wf_app_role not null;

alter table "public"."wf_user_roles"
  add constraint "wf_user_roles_pkey" primary key (user_id, role);

create policy "bob_full_read" on "public"."wf_user_roles"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "wf_user_roles_select_self" on "public"."wf_user_roles"
  for select
  to "authenticated"
  using ((user_id = ( select auth.uid() as uid)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."wf_user_roles" to "anon", "authenticated", "postgres", "service_role";
