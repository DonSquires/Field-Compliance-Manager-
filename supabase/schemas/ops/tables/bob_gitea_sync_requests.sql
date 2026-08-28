create table "ops"."bob_gitea_sync_requests" (
  "id"           bigint                   generated always as identity not null,
  "requested_at" timestamp with time zone not null default now(),
  "dry_run"      boolean                  not null default false,
  "request_id"   bigint                   not null,
  "triggered_by" text                     not null default 'cron'::text,
  constraint "bob_gitea_sync_requests_pkey" primary key (id)
);

alter table "ops"."bob_gitea_sync_requests"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "ops"."bob_gitea_sync_requests" to "postgres";
