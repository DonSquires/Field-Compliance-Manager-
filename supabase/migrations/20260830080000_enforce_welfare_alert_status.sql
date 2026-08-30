alter table public.welfare_alerts
  drop constraint if exists welfare_alerts_status_check;

alter table public.welfare_alerts
  add constraint welfare_alerts_status_check
  check (status = any (array[
    'pending'::text,
    'acknowledged'::text,
    'resolved'::text
  ]));