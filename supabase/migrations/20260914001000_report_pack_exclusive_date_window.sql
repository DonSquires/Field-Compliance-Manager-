-- Report-pack evidence windows are half-open so the complete selected end day
-- is included, including events with fractional-second timestamps.
CREATE OR REPLACE FUNCTION public.generate_due_report_packs(
  p_period_start date,
  p_period_end date
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_agreement record;
  v_count integer := 0;
  v_data jsonb;
  v_start_ts timestamptz := p_period_start::timestamptz;
  v_end_ts timestamptz := (p_period_end::timestamptz + interval '1 day');
  v_sla_met integer;
  v_sla_breached integer;
  v_sla_running integer;
  v_inc_total integer;
  v_inc_by_sev jsonb;
  v_checkpoints integer;
  v_breaches integer;
  v_facilities jsonb;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start > p_period_end OR p_period_end - p_period_start > 366 THEN
    RAISE EXCEPTION 'Select a valid report period of 366 days or less';
  END IF;

  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active provider administrator required';
  END IF;

  FOR v_agreement IN
    SELECT id, provider_organization_id, monthly_report_template_code
    FROM public.service_agreements
    WHERE provider_organization_id = v_provider
      AND monthly_report_template_code IS NOT NULL
  LOOP
    SELECT count(*) FILTER (WHERE status = 'met'), count(*) FILTER (WHERE status = 'breached'), count(*) FILTER (WHERE status = 'running')
    INTO v_sla_met, v_sla_breached, v_sla_running
    FROM public.sla_clocks
    WHERE service_agreement_id = v_agreement.id
      AND started_at >= v_start_ts AND started_at < v_end_ts;

    SELECT count(*), coalesce(jsonb_object_agg(severity, n), '{}'::jsonb)
    INTO v_inc_total, v_inc_by_sev
    FROM (
      SELECT severity, count(*) AS n
      FROM public.incidents
      WHERE organization_id = v_agreement.provider_organization_id
        AND occurred_at >= v_start_ts AND occurred_at < v_end_ts
      GROUP BY severity
    ) s;

    SELECT count(*) INTO v_checkpoints
    FROM public.patrol_checkpoint_visits
    WHERE organization_id = v_agreement.provider_organization_id
      AND visited_at >= v_start_ts AND visited_at < v_end_ts;

    SELECT count(*) INTO v_breaches
    FROM public.breach_alerts
    WHERE organization_id = v_agreement.provider_organization_id
      AND created_at >= v_start_ts AND created_at < v_end_ts;

    SELECT coalesce(jsonb_agg(jsonb_build_object('siteName', site_name, 'expected', expected, 'completed', completed) ORDER BY site_name), '[]'::jsonb)
    INTO v_facilities
    FROM (
      SELECT coalesce(cs.name, 'Unknown site') AS site_name,
             count(*) AS expected,
             count(*) FILTER (WHERE ss.status = 'completed') AS completed
      FROM public.shift_stops ss
      LEFT JOIN public.client_sites cs ON cs.id = ss.site_id
      WHERE ss.organization_id = v_agreement.provider_organization_id
        AND ss.sla_arrive_by >= v_start_ts AND ss.sla_arrive_by < v_end_ts
      GROUP BY coalesce(cs.name, 'Unknown site')
    ) f;

    v_data := jsonb_build_object(
      'slaMet', coalesce(v_sla_met, 0),
      'slaBreached', coalesce(v_sla_breached, 0),
      'slaRunning', coalesce(v_sla_running, 0),
      'incidentsTotal', coalesce(v_inc_total, 0),
      'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
      'checkpointVisits', coalesce(v_checkpoints, 0),
      'breachAlerts', coalesce(v_breaches, 0),
      'facilities', coalesce(v_facilities, '[]'::jsonb)
    );

    INSERT INTO public.monthly_report_packs (
      organization_id, service_agreement_id, template_code, period_start,
      period_end, status, data, generated_at, generated_by, updated_at
    ) VALUES (
      v_agreement.provider_organization_id, v_agreement.id,
      v_agreement.monthly_report_template_code, p_period_start, p_period_end,
      'generated', v_data, now(), v_actor, now()
    )
    ON CONFLICT (service_agreement_id, template_code, period_start)
    DO UPDATE SET
      data = excluded.data,
      status = CASE WHEN monthly_report_packs.status = 'sent' THEN 'sent' ELSE 'generated' END,
      generated_at = now(), generated_by = v_actor, updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, metadata)
  VALUES (v_provider, v_actor, 'monthly_report_packs_generated', 'monthly_report_packs', jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'pack_count', v_count));
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_due_report_packs(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.generate_due_report_packs(date, date) TO authenticated, service_role;