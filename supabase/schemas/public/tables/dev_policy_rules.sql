create table "public"."dev_policy_rules" (
  "id"          uuid                     not null default gen_random_uuid(),
  "rule_key"    text                     not null,
  "rule_value"  jsonb                    not null,
  "description" text,
  "active"      boolean                  not null default true,
  "created_at"  timestamp with time zone not null default now(),
  constraint "dev_policy_rules_pkey" primary key (id),
  constraint "dev_policy_rules_rule_key_key" unique (rule_key)
);

alter table "public"."dev_policy_rules"
  enable row level security;

create policy "bob_full_read" on "public"."dev_policy_rules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dev_read_authenticated" on "public"."dev_policy_rules"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dev_policy_rules" to "anon", "authenticated", "postgres", "service_role";
