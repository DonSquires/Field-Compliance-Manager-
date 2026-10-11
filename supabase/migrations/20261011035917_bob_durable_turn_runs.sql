create table public.bob_turn_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.bob_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  request_fingerprint text not null,
  status text not null default 'running',
  response_payload jsonb,
  error_code text,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bob_turn_runs_request_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint bob_turn_runs_status_check
    check (status in ('running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  constraint bob_turn_runs_terminal_state_check
    check (
      (status in ('running', 'cancel_requested') and completed_at is null)
      or
      (status in ('completed', 'failed', 'cancelled') and completed_at is not null)
    ),
  constraint bob_turn_runs_conversation_user_request_key
    unique (conversation_id, user_id, request_id)
);

create index bob_turn_runs_user_status_created_idx
  on public.bob_turn_runs (user_id, status, created_at desc);

create index bob_turn_runs_conversation_created_idx
  on public.bob_turn_runs (conversation_id, created_at desc);

alter table public.bob_turn_runs enable row level security;

create policy bob_turn_runs_select_own
  on public.bob_turn_runs
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and org_access_allowed(organization_id)
  );

revoke all on table public.bob_turn_runs from public, anon, authenticated;
grant select on table public.bob_turn_runs to authenticated;
grant select, insert, update, delete on table public.bob_turn_runs to service_role;

comment on table public.bob_turn_runs is
  'Durable, tenant-scoped Bob request ledger. A client request_id is claimed once so browser timeouts and retries can reconcile without duplicating conductor work.';
comment on column public.bob_turn_runs.request_id is
  'Client-generated UUID retained across status checks and safe replays.';
comment on column public.bob_turn_runs.request_fingerprint is
  'SHA-256 of the normalized message, attachment identities, and agent mode. A reused request_id with different input is rejected.';
comment on column public.bob_turn_runs.status is
  'running, cancel_requested, completed, failed, or cancelled. Cancellation is cooperative at conductor boundaries.';
comment on column public.bob_turn_runs.response_payload is
  'Final structured Bob response used to reconcile a timed-out browser without rerunning the turn.';