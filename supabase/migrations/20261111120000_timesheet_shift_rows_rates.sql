-- Shift hours review: return each shift's resolved hourly pay and charge rate so the
-- Timesheets page can total pay and charge for the filtered shifts. Rates are commercial,
-- so only organisation administrators receive them; branch reviewers keep the hours only.
CREATE OR REPLACE FUNCTION public.get_timesheet_shift_rows(p_organization_id uuid, p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rates_visible boolean := public.is_admin_for_org(p_organization_id);
BEGIN
  IF auth.uid() IS NULL OR NOT (v_rates_visible
    OR public.user_can_operate_organization(p_organization_id)) THEN
    RAISE EXCEPTION 'Timesheet review authority required' USING ERRCODE='42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>62 THEN
    RAISE EXCEPTION 'Choose a timesheet range of 63 days or fewer';
  END IF;
  RETURN (WITH evidence AS (
    SELECT s.*,sp.id AS staff_id,up.display_name AS staff_name,r.planned_break_minutes,r.break_unpaid,
      coalesce(b.minutes,0) AS taken_unpaid,c.payable_start,c.payable_end,c.unpaid_minutes,
      c.updated_at AS correction_updated_at,c.source_updated_at AS correction_source_version,
      c.reason AS correction_reason,c.staff_id AS correction_staff_id,c.payable_user_id AS correction_user_id,
      manual.source AS manual_source,manual.staff_id AS manual_staff_id,manual.staff_name AS manual_staff_name,
      manual.user_id AS manual_user_id,manual.reason AS manual_reason,
      pay.amount AS pay_rate,bill.amount AS charge_rate,
      abs(extract(epoch FROM(s.actual_start-s.scheduled_start)))<=900 AS start_matches,
      abs(extract(epoch FROM(s.actual_end-s.scheduled_end)))<=900 AS finish_matches,
      NOT coalesce(r.break_unpaid,false) OR coalesce(r.planned_break_minutes,0)=0
        OR (coalesce(b.minutes,0)>0 AND NOT coalesce(b.open_break,false)
          AND abs(b.minutes-r.planned_break_minutes)<=5) AS break_matches
    FROM public.shifts s
    JOIN public.user_profiles up ON up.id=s.officer_user_id
    LEFT JOIN public.staff_profiles sp ON coalesce(sp.user_id,sp.id)=up.id
    LEFT JOIN public.roster_slots r ON r.linked_shift_id=s.id
    LEFT JOIN public.shift_timesheet_hour_corrections c ON c.shift_id=s.id
    LEFT JOIN public.service_agreement_locations sal ON sal.id=s.service_agreement_location_id
    LEFT JOIN public.service_agreements sa ON sa.id=sal.service_agreement_id
    LEFT JOIN LATERAL (
      SELECT source,t.staff_id,review_user.display_name AS staff_name,coalesce(review_staff.user_id,review_staff.id) AS user_id,
        source->>'reason' AS reason
      FROM public.timesheets t JOIN public.staff_profiles review_staff ON review_staff.id=t.staff_id
      JOIN public.user_profiles review_user ON review_user.id=coalesce(review_staff.user_id,review_staff.id)
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.work_summary->'manual_sources','[]'::jsonb)) source
      WHERE (source->>'shift_id'=s.id::text
        OR (source->>'source_type'='shift' AND source->>'source_id'=s.id::text))
      ORDER BY t.submitted_at DESC LIMIT 1
    ) manual ON true
    CROSS JOIN LATERAL (SELECT sum(extract(epoch FROM(sb.ended_at-sb.started_at))/60)
      FILTER(WHERE sb.ended_at IS NOT NULL) AS minutes,bool_or(sb.ended_at IS NULL) AS open_break
      FROM public.shift_breaks sb WHERE sb.shift_id=s.id AND NOT sb.is_paid) b
    LEFT JOIN LATERAL public.resolve_rate_rule(p_organization_id, 'pay', s.scheduled_start, s.service_type, NULL, s.module_key, sa.client_organization_id, sal.site_id, coalesce(s.zone_id, sal.zone_id), sp.role_code, NULL, NULL, 'hourly') pay ON v_rates_visible
    LEFT JOIN LATERAL public.resolve_rate_rule(p_organization_id, 'billing', s.scheduled_start, s.service_type, NULL, s.module_key, sa.client_organization_id, sal.site_id, coalesce(s.zone_id, sal.zone_id), NULL, NULL, NULL, 'hourly') bill ON v_rates_visible
    WHERE s.organization_id=p_organization_id AND s.status NOT IN('cancelled','declined')
      AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date BETWEEN p_from AND p_to
      AND (p_staff_id IS NULL OR coalesce(manual.staff_id,c.staff_id,sp.id)=p_staff_id)
      AND (v_rates_visible OR public.user_can_exercise_branch_authority(
        p_organization_id,coalesce(manual.user_id,c.payable_user_id,sp.user_id,sp.id),'timesheet_local_review'))
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'organization_id',organization_id,'staff_id',coalesce(manual_staff_id,correction_staff_id,staff_id),
    'staff_name',coalesce(manual_staff_name,staff_name),
    'officer_user_id',officer_user_id,'service_type',service_type,'status',status,'updated_at',updated_at,
    'scheduled_start',scheduled_start,'scheduled_end',scheduled_end,'actual_start',actual_start,'actual_end',actual_end,
    'payable_start',CASE WHEN correction_source_version=updated_at THEN payable_start
      WHEN manual_source IS NOT NULL THEN (manual_source->>'reviewed_start')::timestamptz
      WHEN start_matches THEN scheduled_start ELSE actual_start END,
    'payable_end',CASE WHEN correction_source_version=updated_at THEN payable_end
      WHEN manual_source IS NOT NULL THEN (manual_source->>'reviewed_end')::timestamptz
      WHEN finish_matches THEN scheduled_end ELSE actual_end END,
    'unpaid_minutes',CASE WHEN correction_source_version=updated_at THEN unpaid_minutes
      WHEN manual_source IS NOT NULL THEN (manual_source->>'unpaid_break_minutes')::integer
      WHEN coalesce(break_unpaid,false) AND planned_break_minutes>0 AND break_matches THEN planned_break_minutes
      ELSE round(taken_unpaid)::integer END,
    'planned_unpaid_minutes',CASE WHEN break_unpaid THEN coalesce(planned_break_minutes,0) ELSE 0 END,
    'recorded_unpaid_minutes',taken_unpaid,'correction_updated_at',correction_updated_at,
    'correction_reason',coalesce(correction_reason,manual_reason),
    'manual_update',manual_source IS NOT NULL OR correction_updated_at IS NOT NULL,
    'hours_status',CASE WHEN correction_updated_at IS NOT NULL OR manual_source IS NOT NULL THEN 'review'
      WHEN status='missed' OR (actual_start IS NULL AND scheduled_end<now() AND status IN('scheduled','published','accepted')) THEN 'missed'
      WHEN status='completed' AND actual_end>actual_start AND start_matches AND finish_matches AND break_matches THEN 'confirmed'
      WHEN status='completed' THEN 'review' ELSE 'pending' END,
    'start_mismatch',NOT coalesce(start_matches,false),'finish_mismatch',NOT coalesce(finish_matches,false),
    'unpaid_break_mismatch',NOT break_matches
  ) || CASE WHEN v_rates_visible THEN jsonb_build_object('pay_rate',pay_rate,'charge_rate',charge_rate) ELSE '{}'::jsonb END
  ORDER BY scheduled_start,staff_name),'[]'::jsonb) FROM evidence);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_timesheet_shift_rows(uuid, date, date, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_timesheet_shift_rows(uuid, date, date, uuid) TO authenticated, service_role;
