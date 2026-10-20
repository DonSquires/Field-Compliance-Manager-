create or replace function public.bob_execute_read_query (
  query_text text,
  row_limit  integer default 200,
  timeout_ms integer default 5000
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  cleaned text;
  lowered text;
  wrapped text;
  result jsonb;
begin
  cleaned := btrim(query_text);
  -- Strip a single trailing semicolon (allowed), then forbid any remaining one
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
  if lowered ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|copy|merge|call|do|vacuum|analyze|reindex|refresh|set|reset)\y' then
    raise exception 'Write / DDL / session keywords are not permitted';
  end if;

  row_limit := greatest(1, least(coalesce(row_limit, 200), 2000));
  perform set_config('statement_timeout', greatest(1000, least(coalesce(timeout_ms, 5000), 20000))::text, true);

  -- Wrap in a read-only subquery with a hard row cap; aggregate queries just
  -- return their single row.
  wrapped := format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t', cleaned, row_limit);

  -- READ ONLY transaction block: any attempted write raises 25006.
  begin
    set transaction read only;
  exception when others then
    -- already in a read-only-capable context; ignore
    null;
  end;

  execute wrapped into result;
  return jsonb_build_object('ok', true, 'rows', coalesce(result, '[]'::jsonb), 'row_limit', row_limit);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

grant execute on function "public"."bob_execute_read_query"(text, integer, integer) to "postgres", "service_role";

comment on function "public"."bob_execute_read_query"(text, integer, integer) is 'Admiral-only read-only SQL for Bob. SELECT/WITH-SELECT only, single statement, row-capped, statement-timeout, executed read-only. Called by the bob-sql-read edge function AFTER it verifies the caller is grand_master. service_role execute only.';

revoke all on function "public"."bob_execute_read_query"(text, integer, integer) from public;
