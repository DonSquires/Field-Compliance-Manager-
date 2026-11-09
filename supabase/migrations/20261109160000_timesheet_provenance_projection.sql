CREATE OR REPLACE FUNCTION public.get_timesheet_provenance(
  p_timesheet_ids uuid[],
  p_operating_organization_id uuid
)
RETURNS TABLE(
  timesheet_id uuid,
  organization_id uuid,
  organization_name text,
  operating_organization_id uuid,
  operating_organization_name text,
  shift_id uuid,
  service_type text,
  work_unit_name text,
  location_name text,
  zone_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_timesheet_ids IS NULL OR cardinality(p_timesheet_ids) > 500 THEN
    RAISE EXCEPTION 'Request at most 500 timesheets';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT unnest(p_timesheet_ids) AS id) requested
    LEFT JOIN public.timesheets t ON t.id = requested.id
    LEFT JOIN public.staff_profiles sp ON sp.id = t.staff_id
    WHERE t.id IS NULL OR NOT (
      public.is_admin_for_org(t.organization_id)
      OR (
        p_operating_organization_id IS NOT NULL
        AND public.user_can_operate_organization(p_operating_organization_id)
        AND public.user_can_exercise_branch_authority(
          p_operating_organization_id, coalesce(sp.user_id, sp.id), 'timesheet_local_review'
        )
        AND EXISTS (
          SELECT 1 FROM public.staff_branch_authorisations assignment
          WHERE assignment.user_id = coalesce(sp.user_id, sp.id)
            AND assignment.branch_org_id = p_operating_organization_id
            AND assignment.status = 'active'
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Timesheet provenance authority required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT unnest(p_timesheet_ids) AS id
  ), visible AS (
    SELECT t.id, t.organization_id, t.staff_id, t.shift_id, t.work_summary
    FROM public.timesheets t
    JOIN requested ON requested.id = t.id
  ), source_shifts AS (
    SELECT visible.id AS timesheet_id, visible.shift_id
    FROM visible
    WHERE visible.shift_id IS NOT NULL
    UNION
    SELECT entry.timesheet_id, entry.source_id
    FROM public.timesheet_work_entries entry
    JOIN requested ON requested.id = entry.timesheet_id
    WHERE entry.source_type = 'shift'
    UNION
    SELECT visible.id, (source.value->>'shift_id')::uuid
    FROM visible
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(visible.work_summary->'manual_sources', '[]'::jsonb)) source(value)
    WHERE source.value->>'shift_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  SELECT visible.id,
    visible.organization_id,
    employer.name,
    p_operating_organization_id,
    operating.name,
    shift.id,
    shift.service_type,
    work_unit.name,
    place.name,
    zone.name
  FROM visible
  JOIN public.organizations employer ON employer.id = visible.organization_id
  LEFT JOIN public.organizations operating ON operating.id = p_operating_organization_id
    AND (public.is_admin_for_org(p_operating_organization_id)
      OR public.user_can_operate_organization(p_operating_organization_id))
  LEFT JOIN source_shifts source ON source.timesheet_id = visible.id
  LEFT JOIN public.shifts shift ON shift.id = source.shift_id AND shift.organization_id = visible.organization_id
  LEFT JOIN public.location_zones zone ON zone.id = shift.zone_id
  LEFT JOIN public.locations place ON place.id = coalesce(shift.location_id, zone.location_id)
  LEFT JOIN public.roster_work_units work_unit ON work_unit.id = shift.work_unit_id
  ORDER BY visible.id, shift.scheduled_start NULLS LAST, shift.id;
END;
$function$;

COMMENT ON FUNCTION public.get_timesheet_provenance(uuid[], uuid) IS
  'Returns employer and shift-place labels for visible timesheets. Employer admins use their organisation authority; branch reviewers must hold active branch assignment and timesheet_local_review authority.';
REVOKE ALL ON FUNCTION public.get_timesheet_provenance(uuid[], uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_timesheet_provenance(uuid[], uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_timesheet_provenance(uuid[], uuid) TO authenticated;