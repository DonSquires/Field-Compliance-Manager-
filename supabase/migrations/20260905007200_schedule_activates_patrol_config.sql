ALTER TABLE public.client_site_patrol_config
  ADD COLUMN proposal_scope_schedule_id uuid REFERENCES public.quote_proposal_scope_schedules(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_cspc_proposal_schedule ON public.client_site_patrol_config(proposal_scope_schedule_id) WHERE proposal_scope_schedule_id IS NOT NULL;

-- Accepted permanent capability schedules (patrol/static/noise/freedom_camping)
-- must reach the real patrol engine, not only the CRM display spec. Ad hoc
-- alarm_response stays dispatch-driven and is deliberately excluded here.
CREATE OR REPLACE FUNCTION public.activate_quote_proposal_scope_schedules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    INSERT INTO public.service_agreement_delivery_schedules(service_agreement_id,proposal_scope_schedule_id,site_id,zone_id,module_key,capability_key,work_model,active_days,active_months,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,depart_sla_minutes,dwell_minutes,preferred_stop_order,pricing_basis,rate_rule_id,chargeable_conditions,notes,officer_instructions)
    SELECT new.service_agreement_id,schedule.id,coalesce(scope.site_id,place.converted_site_id),coalesce(scope.zone_id,place.converted_zone_id),scope.module_key,schedule.capability_key,schedule.work_model,schedule.active_days,schedule.active_months,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,schedule.window_start,schedule.window_end,schedule.response_sla_minutes,schedule.depart_sla_minutes,schedule.dwell_minutes,schedule.preferred_stop_order,schedule.pricing_basis,schedule.rate_rule_id,schedule.chargeable_conditions,schedule.notes,schedule.officer_instructions
    FROM public.quote_proposal_scope_schedules schedule
    JOIN public.quote_proposal_service_scopes scope ON scope.id=schedule.proposal_scope_id
    LEFT JOIN public.quote_proposal_places place ON place.id=scope.proposed_place_id
    WHERE scope.quote_id=new.id
    ON CONFLICT(proposal_scope_schedule_id) DO NOTHING;

    INSERT INTO public.client_site_patrol_config(organization_id,site_id,zone_id,module_key,active_days,visits_per_shift,min_gap_between_visits_minutes,time_window_type,window_start,window_end,active_months,dwell_minutes,sla_arrive_within_minutes,sla_depart_within_minutes,preferred_stop_order,officer_instructions,proposal_scope_schedule_id)
    SELECT new.provider_org_id,coalesce(scope.site_id,place.converted_site_id),coalesce(scope.zone_id,place.converted_zone_id),
      CASE schedule.capability_key WHEN 'patrol' THEN 'general_patrol' ELSE schedule.capability_key END,
      schedule.active_days,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,
      'fixed',schedule.window_start,schedule.window_end,schedule.active_months,schedule.dwell_minutes,
      coalesce(schedule.response_sla_minutes,30),coalesce(schedule.depart_sla_minutes,45),
      schedule.preferred_stop_order,schedule.officer_instructions,schedule.id
    FROM public.quote_proposal_scope_schedules schedule
    JOIN public.quote_proposal_service_scopes scope ON scope.id=schedule.proposal_scope_id
    LEFT JOIN public.quote_proposal_places place ON place.id=scope.proposed_place_id
    WHERE scope.quote_id=new.id AND schedule.capability_key<>'alarm_response'
    ON CONFLICT (proposal_scope_schedule_id) WHERE proposal_scope_schedule_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN new;
END;$$;

REVOKE ALL ON FUNCTION public.activate_quote_proposal_scope_schedules() FROM PUBLIC,anon,authenticated;
