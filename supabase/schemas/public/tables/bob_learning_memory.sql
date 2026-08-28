create table "public"."bob_learning_memory" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "user_id"         uuid,
  "memory_kind"     text                     not null,
  "content"         text                     not null,
  "source"          text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "bob_learning_memory_memory_kind_check"
    check ((memory_kind = ANY (ARRAY['lesson'::text, 'success_pattern'::text, 'failure_pattern'::text, 'user_preference'::text, 'global'::text]))),
  constraint "bob_learning_memory_pkey" primary key (id),
  constraint "bob_learning_memory_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "bob_learning_memory_user_id_fkey" foreign key (user_id) references public.user_profiles(id)
);

alter table "public"."bob_learning_memory"
  enable row level security;

create policy "bob_full_read" on "public"."bob_learning_memory"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "bob_learning_memory_select" on "public"."bob_learning_memory"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_learning_memory" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_learning_memory" is 'Bob adaptive learning memory. Lessons, success patterns, failure patterns, and user preferences.';
