alter table public.bob_turn_runs
  drop constraint bob_turn_runs_status_check;

alter table public.bob_turn_runs
  add constraint bob_turn_runs_status_check
  check (status in ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled'));

alter table public.bob_turn_runs
  drop constraint bob_turn_runs_terminal_state_check;

alter table public.bob_turn_runs
  add constraint bob_turn_runs_terminal_state_check
  check (
    (status in ('queued', 'running', 'cancel_requested') and completed_at is null)
    or
    (status in ('completed', 'failed', 'cancelled') and completed_at is not null)
  );

create index bob_turn_runs_queue_created_idx
  on public.bob_turn_runs (status, created_at)
  where status = 'queued';

comment on column public.bob_turn_runs.status is
  'queued, running, cancel_requested, completed, failed, or cancelled. Queued requests return to the caller immediately and are claimed once by background execution.';