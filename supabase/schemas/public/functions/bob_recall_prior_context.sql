create or replace function public.bob_recall_prior_context (
  search_terms  text,
  scope_org_id  uuid    default null::uuid,
  max_results   integer default 15,
  lookback_days integer default 30
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_results jsonb := '[]'::jsonb;
  v_rulings jsonb;
  v_learnings jsonb;
  v_derived jsonb;
  v_events jsonb;
  v_jobs jsonb;
  v_cutoff timestamptz;
  v_terms text;
begin
  -- Sanitise inputs
  v_terms := lower(btrim(coalesce(search_terms, '')));
  if v_terms = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'search_terms is required'
    );
  end if;

  max_results := greatest(1, least(coalesce(max_results, 15), 50));
  lookback_days := greatest(1, least(coalesce(lookback_days, 30), 365));
  v_cutoff := now() - (lookback_days || ' days')::interval;

  -- 1. Owner rulings (highest authority, always included)
  select coalesce(jsonb_agg(r order by r.created_at desc), '[]'::jsonb)
  into v_rulings
  from (
    select
      'owner_ruling'::text as source_type,
      id,
      ruling_key as key,
      title,
      ruling_text as content,
      domain as category,
      1.0::double precision as authority,
      created_at
    from public.bob_owner_rulings
    where ruling_status = 'active'
      and (
        lower(ruling_text) like '%' || v_terms || '%'
        or lower(title) like '%' || v_terms || '%'
        or lower(ruling_key) like '%' || v_terms || '%'
        or lower(domain) like '%' || v_terms || '%'
      )
    limit least(max_results, 10)
  ) r;

  -- 2. Knowledge cards with relevant categories
  select coalesce(jsonb_agg(k order by k.created_at desc), '[]'::jsonb)
  into v_learnings
  from (
    select
      'knowledge_card'::text as source_type,
      id,
      key,
      title,
      content,
      category,
      0.8::double precision as authority,
      created_at
    from public.bob_knowledge_cards
    where is_active
      and category in ('learning', 'ruling', 'discipline', 'governance')
      and (organization_id is null or organization_id = scope_org_id)
      and (
        lower(content) like '%' || v_terms || '%'
        or lower(title) like '%' || v_terms || '%'
        or lower(key) like '%' || v_terms || '%'
      )
    limit least(max_results, 10)
  ) k;

  -- 3. Derived learnings (approved + auto_digest; proposed at lower authority)
  select coalesce(jsonb_agg(d order by d.created_at desc), '[]'::jsonb)
  into v_derived
  from (
    select
      'derived_learning'::text as source_type,
      id,
      learning_key as key,
      title,
      learning_text as content,
      learning_type as category,
      case
        when learning_status = 'approved' then 0.9::double precision
        when learning_status = 'auto_digest' then 0.3::double precision
        else 0.2::double precision  -- proposed
      end as authority,
      created_at
    from public.bob_learnings
    where learning_status in ('approved', 'auto_digest', 'proposed')
      and (
        lower(learning_text) like '%' || v_terms || '%'
        or lower(title) like '%' || v_terms || '%'
        or lower(learning_key) like '%' || v_terms || '%'
      )
    limit least(max_results, 10)
  ) d;

  -- 4. Recent event_log failures/outcomes (org-scoped)
  select coalesce(jsonb_agg(e order by e.created_at desc), '[]'::jsonb)
  into v_events
  from (
    select
      'event_log'::text as source_type,
      id,
      event_type as key,
      tool as title,
      outcome as content,
      event_type as category,
      0.5::double precision as authority,
      created_at
    from public.bob_event_log
    where created_at >= v_cutoff
      and (scope_org_id is null or organization_id = scope_org_id)
      and outcome is not null
      and (
        lower(coalesce(outcome, '')) like '%' || v_terms || '%'
        or lower(coalesce(tool, '')) like '%' || v_terms || '%'
        or lower(event_type) like '%' || v_terms || '%'
      )
    limit least(max_results, 10)
  ) e;

  -- 5. Recent job_runs outcomes (org-scoped)
  select coalesce(jsonb_agg(j order by j.created_at desc), '[]'::jsonb)
  into v_jobs
  from (
    select
      'job_run'::text as source_type,
      id,
      status as key,
      goal as title,
      stopped_reason as content,
      status as category,
      0.4::double precision as authority,
      created_at
    from public.bob_job_runs
    where created_at >= v_cutoff
      and (scope_org_id is null or organization_id = scope_org_id)
      and (
        lower(coalesce(goal, '')) like '%' || v_terms || '%'
        or lower(coalesce(stopped_reason, '')) like '%' || v_terms || '%'
        or lower(status) like '%' || v_terms || '%'
      )
    limit least(max_results, 10)
  ) j;

  -- Combine all results
  v_results := v_rulings || v_learnings || v_derived || v_events || v_jobs;

  return jsonb_build_object(
    'ok', true,
    'results', v_results,
    'counts', jsonb_build_object(
      'rulings', jsonb_array_length(v_rulings),
      'learnings', jsonb_array_length(v_learnings),
      'derived', jsonb_array_length(v_derived),
      'events', jsonb_array_length(v_events),
      'jobs', jsonb_array_length(v_jobs)
    ),
    'search_terms', search_terms,
    'lookback_days', lookback_days
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

grant execute on function "public"."bob_recall_prior_context"(text, uuid, integer, integer) to "anon", "authenticated", "postgres", "service_role";

comment on function "public"."bob_recall_prior_context"(text, uuid, integer, integer) is 'Runtime retrieval for Bob: queries prior owner rulings, learnings, event-log outcomes, and job-run results matching search terms. Returns a unified result set ordered by authority (rulings > learnings > events > jobs). Bob calls this via sql_read or directly as an RPC before acting on a topic where prior context may exist. Read-only. Issue #232, epic #228.';

revoke all on function "public"."bob_recall_prior_context"(text, uuid, integer, integer) from public;
