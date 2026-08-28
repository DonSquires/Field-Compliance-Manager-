create or replace function public.resolve_access_basis_batch (
  p_observation_ids uuid[]
)
  returns SETOF public.access_basis_verdict
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_caller uuid := auth.uid();
  v_count  int  := coalesce(array_length(p_observation_ids, 1), 0);
begin
  -- ========================================================
  -- INPUT CAP: hard cap of 200 ids per call. Over-cap -> reject the whole
  -- call. Do NOT silently truncate. Prevents the batch becoming a
  -- bulk-enumeration primitive.
  -- ========================================================
  if v_count > 200 then
    raise exception 'resolve_access_basis_batch: input cap exceeded (% ids, max 200)', v_count;
  end if;

  -- ========================================================
  -- SELF-ONLY: unauthenticated caller -> every id gets the collapsed
  -- no-basis verdict. There is NO p_user parameter at all; the caller
  -- identity is derived server-side from auth.uid() only.
  -- ========================================================
  if v_caller is null then
    return query
      select
        req.id,
        'no_task_entitlement'::text,
        null::text,
        'task'::text,
        null::text,
        'informative'::text,
        'access.no_live_basis'::text
      from unnest(p_observation_ids) as req(id);
    return;
  end if;

  -- ========================================================
  -- BATCHED BASIS DERIVATION
  -- Mirrors 0329 branches and ordering per id, applied set-wise.
  -- Composition order (first-match-by-depth, strongest first):
  --   1. ownership (follow_up_ownership / direct_module_initiation) -> full
  --   2. backup_attachment -> operational_only
  --   3. dispatch on-scene -> full_access
  --   4. dispatch en-route -> operational_only
  --   5. rostered_presence -> operational_only
  --   6. supervisory_review -> operational_only
  --
  -- The CTE chain resolves ALL matching bases per id, ranks them by the
  -- same depth ordering as 0329, and picks the strongest (first match).
  -- Any requested id with no match gets the collapsed no-basis verdict
  -- via LEFT JOIN against the input array (EXISTENCE COLLAPSE).
  -- ========================================================
  return query
  with
    -- Unnest the input array into a relation for joining.
    requested as (
      select unnest(p_observation_ids) as obs_id
    ),

    -- BRANCH 1: ownership-derived bases (task_assignments).
    -- follow_up_ownership / direct_module_initiation -> full_access (depth 1,2)
    -- backup_attachment -> operational_only (depth 3)
    -- Mirrors 0329 ownership block verbatim.
    ownership as (
      select distinct on (ta.observation_id)
        ta.observation_id as obs_id,
        ta.basis,
        'basis_ends: ' || coalesce(ta.end_reason, 'live until ended_at set') as expiry
      from public.task_assignments ta
      join requested r on r.obs_id = ta.observation_id
      where ta.user_id = v_caller
        and ta.ended_at is null
        and ta.observation_id is not null
      order by ta.observation_id,
        case ta.basis
          when 'follow_up_ownership'      then 1
          when 'direct_module_initiation' then 2
          when 'backup_attachment'        then 3
          else 4
        end
    ),

    -- BRANCH 2: dispatch on-scene (full_access).
    -- 0327 site-anchored: dj.client_site_id = o.site_id.
    -- Mirrors 0329 dispatch on-scene block verbatim.
    dispatch_on_scene as (
      select distinct on (o.id)
        o.id as obs_id
      from public.observations o
      join requested r on r.obs_id = o.id
      join public.dispatch_jobs dj on dj.client_site_id = o.site_id
      join public.dispatch_resources dr on dr.id = dj.dispatch_resource_id
      where dr.assigned_officer_id = v_caller
        and dj.dispatched_at is not null
        and dj.completed_at is null
        and dj.on_scene_at is not null
        and o.site_id is not null
    ),

    -- BRANCH 3: dispatch en-route (operational_only).
    -- Same join as on-scene but WITHOUT on_scene_at requirement.
    -- Exclude ids already matched by on-scene (first-match-by-depth).
    dispatch_en_route as (
      select distinct on (o.id)
        o.id as obs_id
      from public.observations o
      join requested r on r.obs_id = o.id
      join public.dispatch_jobs dj on dj.client_site_id = o.site_id
      join public.dispatch_resources dr on dr.id = dj.dispatch_resource_id
      where dr.assigned_officer_id = v_caller
        and dj.dispatched_at is not null
        and dj.completed_at is null
        and o.site_id is not null
        and o.id not in (select dos.obs_id from dispatch_on_scene dos)
    ),

    -- BRANCH 4: rostered_presence (operational_only).
    -- Officer link: shift_stops -> shifts.officer_user_id.
    -- Mirrors 0329 roster block verbatim.
    roster as (
      select distinct on (o.id)
        o.id as obs_id
      from public.observations o
      join requested r on r.obs_id = o.id
      join public.shift_stops ss on (
           (ss.site_id is not null and ss.site_id = o.site_id)
        or (ss.zone_id is not null and ss.zone_id = o.zone_id)
      )
      join public.shifts s on s.id = ss.shift_id
      where s.officer_user_id = v_caller
        and ss.status not in ('completed', 'skipped', 'cancelled')
    ),

    -- BRANCH 5: supervisory_review (operational_only).
    -- staff_reporting: caller is reports_to for an officer who holds a live
    -- task basis on this observation. Mirrors 0329 supervisory block.
    supervisory as (
      select distinct on (ta.observation_id)
        ta.observation_id as obs_id
      from public.staff_reporting sr
      join public.task_assignments ta
        on ta.user_id = sr.user_id
        and ta.ended_at is null
        and ta.observation_id is not null
      join requested r on r.obs_id = ta.observation_id
      where sr.reports_to_user_id = v_caller
        and sr.effective_to is null
    ),

    -- COMPOSE: first-match-by-depth per id. The COALESCE chain mirrors the
    -- 0329 branch ordering: ownership > dispatch on-scene > dispatch en-route
    -- > roster > supervisory. For each id, the first non-null match wins.
    resolved as (
      select
        r.obs_id,
        -- Decision state: full_access or operational_only depending on basis.
        case
          when ow.basis in ('follow_up_ownership', 'direct_module_initiation') then 'full_access'
          when ow.basis = 'backup_attachment' then 'operational_only'
          when dos.obs_id is not null then 'full_access'
          when der.obs_id is not null then 'operational_only'
          when ros.obs_id is not null then 'operational_only'
          when sup.obs_id is not null then 'operational_only'
          else null  -- no basis found
        end as decision_state,
        -- Granted basis name.
        case
          when ow.basis is not null then ow.basis
          when dos.obs_id is not null then 'dispatch_response'
          when der.obs_id is not null then 'dispatch_response'
          when ros.obs_id is not null then 'rostered_presence'
          when sup.obs_id is not null then 'supervisory_review'
          else null
        end as granted_basis,
        -- Expiry end condition.
        case
          when ow.basis is not null then ow.expiry
          when dos.obs_id is not null then 'basis_ends: dispatch completed_at set, reassignment, or 24h grace (Q1)'
          when der.obs_id is not null then 'basis_ends: dispatch completed_at set, reassignment, or 24h grace (Q1)'
          when ros.obs_id is not null then 'basis_ends: stop completed/skipped/cancelled or shift end'
          when sup.obs_id is not null then 'basis_ends: reporting responsibility ends or supervised task ends (R2)'
          else null
        end as expiry_end_condition,
        -- Message key.
        case
          when ow.basis in ('follow_up_ownership', 'direct_module_initiation')
            then 'access.granted.' || ow.basis
          when ow.basis = 'backup_attachment'
            then 'access.granted.backup_attachment'
          when dos.obs_id is not null then 'access.granted.dispatch_response.on_scene'
          when der.obs_id is not null then 'access.granted.dispatch_response.en_route'
          when ros.obs_id is not null then 'access.granted.rostered_presence'
          when sup.obs_id is not null then 'access.granted.supervisory_review'
          else null
        end as message_key
      from requested r
      left join ownership ow on ow.obs_id = r.obs_id
      left join dispatch_on_scene dos on dos.obs_id = r.obs_id
      left join dispatch_en_route der on der.obs_id = r.obs_id
      left join roster ros on ros.obs_id = r.obs_id
      left join supervisory sup on sup.obs_id = r.obs_id
    )

  -- FINAL SELECT: one row per requested id. EXISTENCE COLLAPSE: ids with
  -- no basis (including nonexistent ids that never matched any join) get
  -- the identical no-basis verdict via COALESCE.
  select
    rv.obs_id                                                          as id,
    coalesce(rv.decision_state, 'no_task_entitlement')                 as decision_state,
    rv.granted_basis                                                   as granted_basis,
    case when rv.decision_state is not null then 'none' else 'task' end as failed_gate,
    rv.expiry_end_condition                                            as expiry_end_condition,
    'informative'::text                                                as sensitivity_mode,
    coalesce(rv.message_key, 'access.no_live_basis')                   as message_key
  from resolved rv;
end;
$function$;

grant execute on function "public"."resolve_access_basis_batch"(uuid[]) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_access_basis_batch"(uuid[]) is 'BATCHED BASIS ENGINE (ACCESS_MODEL.md sections 8/11, step-4 prerequisite). Ratified plan: docs/design/BATCHED_ACCESS_BASIS_RESOLVER.md (!1292). SECURITY DEFINER + fixed search_path. SELF-ONLY: caller derived from auth.uid(); NO p_user parameter. Observations-only (not the 7-type polymorphic batch). Returns one verdict row per requested id; existence collapsed (nonexistent/inaccessible/no-basis ids all yield the identical no-basis shape). Input cap: 200 ids. Static SQL only. Additive: does not touch the single-record resolver, the RLS boolean, or the keystone.';
