create or replace function public.bob_execute_read_query_scoped (
  query_text text,
  row_limit  integer default 50,
  timeout_ms integer default 5000
)
  returns jsonb
  language plpgsql
  set search_path to 'public'
  AS $function$
declare
  cleaned text;
  lowered text;
  wrapped text;
  result jsonb;
begin
  -- Apply per-call statement timeout (local to this transaction).
  perform set_config(
    'statement_timeout',
    greatest(1000, least(coalesce(timeout_ms, 5000), 20000))::text,
    true
  );

  -- Force read-only transaction so writes are physically impossible.
  set local transaction read only;

  cleaned := btrim(query_text);
  -- Strip a single trailing semicolon, then forbid any remaining one
  -- (blocks statement chaining / injection of a second statement).
  cleaned := regexp_replace(cleaned, ';\s*$', '');
  if position(';' in cleaned) > 0 then
    raise exception 'Only a single statement is allowed';
  end if;

  lowered := lower(cleaned);
  -- Must be a read: single SELECT or a CTE that ends in SELECT.
  if left(lowered, 6) <> 'select' and left(lowered, 4) <> 'with' then
    raise exception 'Only SELECT / WITH...SELECT queries are allowed';
  end if;

  -- Belt-and-braces keyword denylist (the READ ONLY tx is the real guard).
  if lowered ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|analyze|reindex|refresh)\y' then
    raise exception 'Write / DDL / session keywords are not permitted';
  end if;

  row_limit := greatest(1, least(coalesce(row_limit, 50), 2000));

  -- Wrap in a subquery with a hard row cap; aggregate queries just
  -- return their single row. RLS is enforced because this function
  -- is SECURITY INVOKER -- the caller''s role policies apply.
  wrapped := format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t',
    cleaned,
    row_limit
  );

  execute wrapped into result;

  return jsonb_build_object(
    'ok', true,
    'rows', coalesce(result, '[]'::jsonb),
    'row_limit', row_limit
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

grant execute on function "public"."bob_execute_read_query_scoped"(text, integer, integer) to "anon", "authenticated", "postgres", "service_role";

comment on function "public"."bob_execute_read_query_scoped"(text, integer, integer) is 'Non-admiral read-only SQL for Bob (security invoker -- RLS applies). SELECT/WITH-SELECT only, single statement, row-capped, statement-timeout, executed read-only. Called by bob-sql-read edge function via callerClient (anon key + user JWT) for captain/commander tiers. Epic #185 E4 (#189).';

revoke all on function "public"."bob_execute_read_query_scoped"(text, integer, integer) from public;
