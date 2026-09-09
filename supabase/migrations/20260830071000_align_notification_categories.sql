alter table public.notifications
  drop constraint if exists notifications_category_check;

alter table public.notifications
  add constraint notifications_category_check
  check (category = any (array[
    'credential_expiry'::text,
    'sla_breach'::text,
    'report_ready'::text,
    'report_reviewed'::text,
    'welfare'::text,
    'dispatch'::text,
    'roster'::text,
    'open_job'::text,
    'system'::text,
    'schema_change_request'::text,
    'bob_conversation'::text,
    'bob_self_memory'::text
  ]));