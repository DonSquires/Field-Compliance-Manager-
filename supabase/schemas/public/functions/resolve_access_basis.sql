create or replace function public.resolve_access_basis (
  p_user                      uuid default auth.uid(),
  p_observation_id            uuid default null::uuid,
  p_noise_assessment_id       uuid default null::uuid,
  p_smoke_assessment_id       uuid default null::uuid,
  p_biosecurity_assessment_id uuid default null::uuid,
  p_incident_id               uuid default null::uuid,
  p_notice_id                 uuid default null::uuid,
  p_enforcement_case_id       uuid default null::uuid
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_ref_count      int;
  v_caller         uuid := auth.uid();
  v_basis          text := null;
  v_expiry         text := null;
begin
  -- ========================================================
  -- 0329 IDENTITY GUARD (SELF-ONLY). Server-derived caller; reject any request
  -- to resolve someone else's basis. This is the ONLY change from the 0327
  -- body; every basis branch below is reproduced verbatim.
  --
  -- p_user defaults to auth.uid() (UI sends no id). If a caller explicitly
  -- passes a p_user that is not themselves, or is unauthenticated, resolve to
  -- NO basis -- an informative, content-free statement (reject by
  -- non-appearance, never an error that would itself confirm anything).
  -- ========================================================
  if v_caller is null or p_user is null or p_user <> v_caller then
    return jsonb_build_object(
      'decision_state',       'no_task_entitlement',
      'granted_basis',        null,
      'failed_gate',          'task',
      'expiry_end_condition', null,
      'sensitivity_mode',     'informative',
      'message_key',          'access.no_live_basis'
    );
  end if;

  -- COMPOSITION CONTRACT (ACCESS_MODEL.md section 7): this resolver returns on
  -- the FIRST basis found, and the branch order below IS the composition rule -
  -- strongest depth first (ownership -> dispatch on-scene -> dispatch en-route
  -- -> roster -> supervisory), so "first match" == "maximum depth". This
  -- ordering is LOAD-BEARING: do not reorder without switching to an explicit
  -- resolve-all-then-take-max-depth form, or a weaker basis could shadow a
  -- stronger one and under-grant (a lockout).
  -- Exactly-one-record guard (mirrors task_assignments chk_one_record).
  v_ref_count :=
      (case when p_observation_id            is not null then 1 else 0 end)
    + (case when p_noise_assessment_id       is not null then 1 else 0 end)
    + (case when p_smoke_assessment_id       is not null then 1 else 0 end)
    + (case when p_biosecurity_assessment_id is not null then 1 else 0 end)
    + (case when p_incident_id               is not null then 1 else 0 end)
    + (case when p_notice_id                 is not null then 1 else 0 end)
    + (case when p_enforcement_case_id       is not null then 1 else 0 end);

  if v_ref_count <> 1 then
    -- Malformed call: no basis. (section 0: absent basis, not a verdict.)
    return jsonb_build_object(
      'decision_state',       'no_task_entitlement',
      'granted_basis',        null,
      'failed_gate',          'task',
      'expiry_end_condition', null,
      'sensitivity_mode',     'informative',
      'message_key',          'access.no_live_basis'
    );
  end if;

  -- ========================================================
  -- OWNERSHIP-DERIVED bases (task_assignments 0323; geofence NOT required).
  -- follow_up_ownership + direct_module_initiation resolve FULL depth.
  -- A live row with ended_at IS NULL is a LIVE basis.
  -- ========================================================
  select ta.basis,
         'basis_ends: ' || coalesce(ta.end_reason, 'live until ended_at set')
    into v_basis, v_expiry
  from public.task_assignments ta
  where ta.user_id = p_user
    and ta.ended_at is null
    and (
         (p_observation_id            is not null and ta.observation_id            = p_observation_id)
      or (p_noise_assessment_id       is not null and ta.noise_assessment_id       = p_noise_assessment_id)
      or (p_smoke_assessment_id       is not null and ta.smoke_assessment_id       = p_smoke_assessment_id)
      or (p_biosecurity_assessment_id is not null and ta.biosecurity_assessment_id = p_biosecurity_assessment_id)
      or (p_incident_id               is not null and ta.incident_id               = p_incident_id)
      or (p_notice_id                 is not null and ta.notice_id                 = p_notice_id)
      or (p_enforcement_case_id       is not null and ta.enforcement_case_id       = p_enforcement_case_id)
    )
    -- Prefer the strongest ownership basis first (follow_up/initiation = full;
    -- backup graduates and is handled in the presence block for its depth).
    order by case ta.basis
               when 'follow_up_ownership'       then 1
               when 'direct_module_initiation'  then 2
               when 'backup_attachment'         then 3
               else 4 end
    limit 1;

  if v_basis in ('follow_up_ownership', 'direct_module_initiation') then
    -- Ownership-derived: FULL working depth (section 3: geofence may be false;
    -- report writing / QA / handover must not break). S12 no-lockout case.
    return jsonb_build_object(
      'decision_state',       'full_access',
      'granted_basis',        v_basis,
      'failed_gate',          'none',
      'expiry_end_condition', v_expiry,
      'sensitivity_mode',     'informative',
      'message_key',          'access.granted.' || v_basis
    );
  elsif v_basis = 'backup_attachment' then
    -- R1: backup graduates. Without a live-geofence gate in v1, the task record
    -- itself is the presence proof; a live backup attachment earns operational
    -- depth (on-scene upgrade is a v-next hardening, ACCESS_MODEL section 3).
    return jsonb_build_object(
      'decision_state',       'operational_only',
      'granted_basis',        'backup_attachment',
      'failed_gate',          'none',
      'expiry_end_condition', v_expiry,
      'sensitivity_mode',     'informative',
      'message_key',          'access.granted.backup_attachment'
    );
  end if;

  -- ========================================================
  -- PRESENCE-DERIVED: dispatch_response (TIMESTAMP-LED graduation, S3/S13).
  -- Officer link: dispatch_jobs.dispatch_resource_id
  --   -> dispatch_resources.assigned_officer_id (live-verified path).
  -- Depth: dispatched_at set -> operational_only (en route);
  --        on_scene_at set   -> full_access (arrived).
  -- 0327 PLACE-LINK (Bug 2 fix): the dispatch job must be for the SAME SITE as
  -- the observation -- dj.client_site_id = o.site_id (the only place pair
  -- anchored in the live schema at both ends). FAIL-CLOSED: an observation with
  -- no site_id gets no dispatch basis (the join cannot match a null).
  -- ========================================================
  if p_observation_id is not null then
    perform 1
      from public.dispatch_jobs dj
      join public.dispatch_resources dr on dr.id = dj.dispatch_resource_id
      join public.observations o on o.id = p_observation_id
     where dr.assigned_officer_id = p_user
       and dj.dispatched_at is not null
       and dj.completed_at is null
       and dj.on_scene_at is not null
       and o.site_id is not null
       and dj.client_site_id = o.site_id;
    if found then
      return jsonb_build_object(
        'decision_state',       'full_access',
        'granted_basis',        'dispatch_response',
        'failed_gate',          'none',
        'expiry_end_condition', 'basis_ends: dispatch completed_at set, reassignment, or 24h grace (Q1)',
        'sensitivity_mode',     'informative',
        'message_key',          'access.granted.dispatch_response.on_scene'
      );
    end if;

    perform 1
      from public.dispatch_jobs dj
      join public.dispatch_resources dr on dr.id = dj.dispatch_resource_id
      join public.observations o on o.id = p_observation_id
     where dr.assigned_officer_id = p_user
       and dj.dispatched_at is not null
       and dj.completed_at is null
       and o.site_id is not null
       and dj.client_site_id = o.site_id;
    if found then
      -- En route (dispatched, not yet on-scene): operational_only (S13/S3).
      return jsonb_build_object(
        'decision_state',       'operational_only',
        'granted_basis',        'dispatch_response',
        'failed_gate',          'none',
        'expiry_end_condition', 'basis_ends: dispatch completed_at set, reassignment, or 24h grace (Q1)',
        'sensitivity_mode',     'informative',
        'message_key',          'access.granted.dispatch_response.en_route'
      );
    end if;
  end if;

  -- ========================================================
  -- PRESENCE-DERIVED: rostered_presence.
  -- Officer link: shift_stops JOIN shifts (shifts.officer_user_id) - shift_stops
  -- has NO direct officer column (live-verified; the substrate-note trap).
  -- Live presence = a non-terminal stop (status not in the done set).
  -- Depth: presence-alone caps at operational_only (section 7 composition, S11).
  -- v1: the roster record is the presence proof (geofence deferred).
  -- ========================================================
  if p_observation_id is not null then
    perform 1
      from public.shift_stops ss
      join public.shifts s on s.id = ss.shift_id
      join public.observations o on o.id = p_observation_id
     where s.officer_user_id = p_user
       and ss.status not in ('completed', 'skipped', 'cancelled')
       and (
              (ss.site_id is not null and ss.site_id = o.site_id)
           or (ss.zone_id is not null and ss.zone_id = o.zone_id)
       );
    if found then
      -- S11: inside the tasked place, presence basis -> operational_only, NEVER
      -- narrative history from presence alone.
      return jsonb_build_object(
        'decision_state',       'operational_only',
        'granted_basis',        'rostered_presence',
        'failed_gate',          'none',
        'expiry_end_condition', 'basis_ends: stop completed/skipped/cancelled or shift end',
        'sensitivity_mode',     'informative',
        'message_key',          'access.granted.rostered_presence'
      );
    end if;
  end if;

  -- ========================================================
  -- PRESENCE/RESPONSIBILITY: supervisory_review (R2 scoped default).
  -- staff_reporting: this user is the reports_to for an officer who holds a live
  -- task basis on THIS record; active line = effective_to IS NULL.
  -- Default depth (sensitive subject-matter): operational_only (R2). The
  -- officer-SAFETY inversion (full_access) is NOT auto-resolved here - it is a
  -- named, record-bound escalation basis (R2 exception / S10), reserved for the
  -- welfare/duress path, never a broad supervisor read.
  -- ========================================================
  perform 1
    from public.staff_reporting sr
    join public.task_assignments ta on ta.user_id = sr.user_id and ta.ended_at is null
   where sr.reports_to_user_id = p_user
     and sr.effective_to is null
     and (
           (p_observation_id            is not null and ta.observation_id            = p_observation_id)
        or (p_noise_assessment_id       is not null and ta.noise_assessment_id       = p_noise_assessment_id)
        or (p_smoke_assessment_id       is not null and ta.smoke_assessment_id       = p_smoke_assessment_id)
        or (p_biosecurity_assessment_id is not null and ta.biosecurity_assessment_id = p_biosecurity_assessment_id)
        or (p_incident_id               is not null and ta.incident_id               = p_incident_id)
        or (p_notice_id                 is not null and ta.notice_id                 = p_notice_id)
        or (p_enforcement_case_id       is not null and ta.enforcement_case_id       = p_enforcement_case_id)
     );
  if found then
    return jsonb_build_object(
      'decision_state',       'operational_only',
      'granted_basis',        'supervisory_review',
      'failed_gate',          'none',
      'expiry_end_condition', 'basis_ends: reporting responsibility ends or supervised task ends (R2)',
      'sensitivity_mode',     'informative',
      'message_key',          'access.granted.supervisory_review'
    );
  end if;

  -- ========================================================
  -- No live task basis found. section 0: this is ABSENT BASIS, not a verdict on
  -- the reader. operator_custody + lawful_production are SEPARATE named bases,
  -- resolved elsewhere (R3) - deliberately NOT granted here.
  -- ========================================================
  return jsonb_build_object(
    'decision_state',       'no_task_entitlement',
    'granted_basis',        null,
    'failed_gate',          'task',
    'expiry_end_condition', null,
    'sensitivity_mode',     'informative',
    'message_key',          'access.no_live_basis'
  );
end;
$function$;

grant execute on function "public"."resolve_access_basis"(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_access_basis"(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) is 'BASIS ENGINE (ACCESS_MODEL.md sections 8/11). SECURITY DEFINER + fixed search_path (0326). 0327: dispatch branch SITE-ANCHORED. 0329: SELF-ONLY - p_user defaults to auth.uid() and any p_user <> auth.uid() (or unauthenticated) resolves to no-basis. Closes the caller-supplied-identity impersonation surface on the direct-RPC / UI path. No supervisor/GM cross-user carve-out (separate privileged path if ever needed). Narrow contract: one SELF user, one record, verdict only.';
