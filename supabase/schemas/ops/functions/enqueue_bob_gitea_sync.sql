create or replace function ops.enqueue_bob_gitea_sync (
  p_dry_run      boolean default false,
  p_triggered_by text    default 'manual'::text
)
  returns bigint
  language plpgsql
  security definer
  set search_path to 'pg_catalog'
  AS $function$
declare
  v_project_url text;
  v_apikey text;
  v_sync_secret text;
  v_request_id bigint;
  v_existing_request_id bigint;
  v_effective_triggered_by text;
  v_caller_role text;
  v_bucket timestamptz;
begin
  -- Caller identity: use JWT role claim when present; fallback to session_user.
  v_caller_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    session_user
  );

  if v_caller_role not in ('postgres', 'service_role') then
    raise exception 'permission denied for ops.enqueue_bob_gitea_sync'
      using errcode = '42501';
  end if;

  -- 60-second dedupe bucket + transaction advisory lock for race safety.
  v_bucket := to_timestamp(floor(extract(epoch from now()) / 60) * 60);

  perform pg_advisory_xact_lock(
    hashtextextended('ops.enqueue_bob_gitea_sync:' || p_dry_run::text || ':' || v_bucket::text, 0)
  );

  select r.request_id
    into v_existing_request_id
  from ops.bob_gitea_sync_requests as r
  where r.dry_run = p_dry_run
    and r.requested_at >= (now() - interval '60 seconds')
  order by r.requested_at desc
  limit 1;

  if v_existing_request_id is not null then
    return v_existing_request_id;
  end if;

  select ds.decrypted_secret into v_project_url
  from vault.decrypted_secrets as ds
  where ds.name = 'project_url'
  limit 1;

  select ds.decrypted_secret into v_apikey
  from vault.decrypted_secrets as ds
  where ds.name = 'bob_sync_apikey'
  limit 1;

  select ds.decrypted_secret into v_sync_secret
  from vault.decrypted_secrets as ds
  where ds.name in ('CRON_SECRET', 'bob_sync_shared_secret')
  order by case when ds.name = 'CRON_SECRET' then 0 else 1 end
  limit 1;

  if v_project_url is null then
    raise exception 'Missing Vault secret: project_url';
  end if;

  if v_apikey is null then
    raise exception 'Missing Vault secret: bob_sync_apikey';
  end if;

  if v_sync_secret is null then
    raise exception 'Missing Vault secret: CRON_SECRET or bob_sync_shared_secret';
  end if;

  v_request_id := net.http_post(
    url := v_project_url || '/functions/v1/bob-gitea-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_apikey,
      'Authorization', 'Bearer ' || v_apikey,
      'x-bob-sync-secret', v_sync_secret,
      'x-cron-secret', v_sync_secret
    ),
    body := jsonb_build_object('dryRun', p_dry_run),
    timeout_milliseconds := 120000
  );

  v_effective_triggered_by := v_caller_role;

  insert into ops.bob_gitea_sync_requests (dry_run, request_id, triggered_by)
  values (p_dry_run, v_request_id, v_effective_triggered_by);

  return v_request_id;
end;
$function$;

grant execute on function "ops"."enqueue_bob_gitea_sync"(boolean, text) to "postgres", "service_role";

revoke all on function "ops"."enqueue_bob_gitea_sync"(boolean, text) from public;
