-- Run the backend-only welfare escalation tick independently of browser sessions.

create or replace function ops.enqueue_welfare_escalation_tick()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_project_url text;
  v_apikey text;
  v_cron_secret text;
  v_request_id bigint;
begin
  if session_user <> 'postgres' and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'permission denied for ops.enqueue_welfare_escalation_tick';
  end if;

  select decrypted_secret into v_project_url
  from vault.decrypted_secrets
  where name = 'project_url'
  limit 1;

  select decrypted_secret into v_apikey
  from vault.decrypted_secrets
  where name = 'bob_sync_apikey'
  limit 1;

  select decrypted_secret into v_cron_secret
  from vault.decrypted_secrets
  where name = 'CRON_SECRET'
  limit 1;

  if v_project_url is null or v_apikey is null or v_cron_secret is null then
    raise exception 'Welfare scheduler requires Vault project_url, bob_sync_apikey, and CRON_SECRET';
  end if;

  v_request_id := net.http_post(
    url := v_project_url || '/functions/v1/welfare-escalation-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_apikey,
      'Authorization', 'Bearer ' || v_apikey,
      'x-cron-secret', v_cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );

  return v_request_id;
end;
$$;

revoke all on function ops.enqueue_welfare_escalation_tick() from public;
grant execute on function ops.enqueue_welfare_escalation_tick() to postgres, service_role;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'welfare-escalation-tick-every-minute'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule_in_database(
    'welfare-escalation-tick-every-minute',
    '* * * * *',
    'select ops.enqueue_welfare_escalation_tick();',
    'postgres',
    null,
    false
  );
end;
$$;
