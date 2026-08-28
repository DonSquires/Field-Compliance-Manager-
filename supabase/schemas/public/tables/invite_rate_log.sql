create table "public"."invite_rate_log" (
  "id"            uuid                     not null default gen_random_uuid(),
  "caller_id"     uuid                     not null,
  "target_org_id" uuid                     not null,
  "attempted_at"  timestamp with time zone not null default now(),
  constraint "invite_rate_log_pkey" primary key (id)
);

alter table "public"."invite_rate_log"
  enable row level security;

create index idx_invite_rate_log_caller on public.invite_rate_log using btree (caller_id, attempted_at);

create index idx_invite_rate_log_org on public.invite_rate_log using btree (target_org_id, attempted_at);

create policy "Service role full access on invite_rate_log" on "public"."invite_rate_log"
  for all
  to PUBLIC
  using (true)
  with check (true);

create policy "bob_full_read" on "public"."invite_rate_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."invite_rate_log" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."invite_rate_log" is 'Rate-limit log for invite-org edge function (#361). Rows older than 10 minutes are garbage — a periodic cleanup or TTL policy can remove them.';
