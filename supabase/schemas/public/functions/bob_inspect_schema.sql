create or replace function public.bob_inspect_schema (
  table_names text[]  default null::text[],
  include_fks boolean default true
)
  returns jsonb
  language sql
  security definer
  set search_path to 'public', 'information_schema'
  AS $function$
  with cols as (
    select
      c.table_name,
      jsonb_agg(
        jsonb_build_object(
          'name', c.column_name,
          'data_type', c.data_type,
          'udt_name', c.udt_name,
          'nullable', (c.is_nullable = 'YES'),
          'default', c.column_default,
          'ordinal', c.ordinal_position
        )
        order by c.ordinal_position
      ) as columns
    from information_schema.columns c
    where c.table_schema = 'public'
      and (table_names is null or c.table_name = any(table_names))
    group by c.table_name
  ),
  cons as (
    select
      tc.table_name,
      jsonb_agg(
        jsonb_build_object(
          'constraint_name', tc.constraint_name,
          'constraint_type', tc.constraint_type
        )
      ) as constraints
    from information_schema.table_constraints tc
    where include_fks
      and tc.table_schema = 'public'
      and (table_names is null or tc.table_name = any(table_names))
    group by tc.table_name
  ),
  fks as (
    select
      tc.table_name,
      jsonb_agg(
        jsonb_build_object(
          'constraint_name', tc.constraint_name,
          'column', kcu.column_name,
          'references_table', ccu.table_name,
          'references_column', ccu.column_name
        )
        order by kcu.column_name
      ) as foreign_keys
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    where include_fks
      and tc.table_schema = 'public'
      and tc.constraint_type = 'FOREIGN KEY'
      and (table_names is null or tc.table_name = any(table_names))
    group by tc.table_name
  ),
  referenced_by as (
    select
      ccu.table_name,
      jsonb_agg(
        distinct jsonb_build_object(
          'from_table', tc.table_name,
          'from_column', kcu.column_name,
          'references_column', ccu.column_name
        )
      ) as referenced_by
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    where include_fks
      and tc.table_schema = 'public'
      and tc.constraint_type = 'FOREIGN KEY'
      and (table_names is null or ccu.table_name = any(table_names))
    group by ccu.table_name
  )
  select coalesce(
    jsonb_build_object(
      'success', true,
      'schema', 'public',
      'include_fks', include_fks,
      'tables', jsonb_agg(
        jsonb_build_object(
          'table', cols.table_name,
          'columns', cols.columns,
          'constraints', coalesce(cons.constraints, '[]'::jsonb),
          'foreign_keys', coalesce(fks.foreign_keys, '[]'::jsonb),
          'referenced_by', coalesce(referenced_by.referenced_by, '[]'::jsonb)
        )
        order by cols.table_name
      ),
      'table_count', count(*)
    ),
    jsonb_build_object('success', true, 'schema', 'public', 'tables', '[]'::jsonb, 'table_count', 0)
  )
  from cols
  left join cons on cons.table_name = cols.table_name
  left join fks on fks.table_name = cols.table_name
  left join referenced_by on referenced_by.table_name = cols.table_name;
$function$;

grant execute on function "public"."bob_inspect_schema"(text[], boolean) to "anon", "authenticated", "postgres", "service_role";

comment on function "public"."bob_inspect_schema"(text[], boolean) is 'Read-only public-schema introspection. include_fks=false skips the expensive FK/constraint joins so the ALL-tables call does not hit the edge statement timeout (used by Bob''s import planner, which needs columns only). include_fks=true (default) returns relationships for scoped table lists.';

revoke all on function "public"."bob_inspect_schema"(text[], boolean) from public;
