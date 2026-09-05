ALTER TABLE public.quote_proposal_service_scopes
  ADD COLUMN proposed_place_id uuid REFERENCES public.quote_proposal_places(id) ON DELETE RESTRICT;
ALTER TABLE public.quote_proposal_service_scopes DROP CONSTRAINT quote_proposal_service_scopes_place_xor;
ALTER TABLE public.quote_proposal_service_scopes DROP CONSTRAINT quote_proposal_service_scopes_unique;
ALTER TABLE public.quote_proposal_service_scopes
  ADD CONSTRAINT quote_proposal_service_scopes_place_xor CHECK (num_nonnulls(site_id,zone_id,proposed_place_id)=1),
  ADD CONSTRAINT quote_proposal_service_scopes_unique UNIQUE NULLS NOT DISTINCT (quote_id,module_key,site_id,zone_id,proposed_place_id);

DROP FUNCTION public.manage_crm_quote_proposal_service_scope(uuid,uuid,text,text,uuid,uuid);
CREATE FUNCTION public.manage_crm_quote_proposal_service_scope(p_client_request_id uuid,p_quote_id uuid,p_action text,p_module_key text,p_site_id uuid DEFAULT NULL,p_zone_id uuid DEFAULT NULL,p_proposed_place_id uuid DEFAULT NULL)
RETURNS public.quote_proposal_service_scopes LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_scope public.quote_proposal_service_scopes%rowtype;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required';END IF;
  SELECT * INTO v_quote FROM public.quotes WHERE id=p_quote_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_quote.provider_org_id) OR v_quote.status<>'draft' THEN RAISE EXCEPTION 'Draft quote administration required';END IF;
  IF p_action NOT IN ('set','remove') OR NOT EXISTS(SELECT 1 FROM public.quote_proposal_modules module WHERE module.quote_id=v_quote.id AND module.module_key=p_module_key) OR num_nonnulls(p_site_id,p_zone_id,p_proposed_place_id)<>1 THEN RAISE EXCEPTION 'Proposal scope requires one selected module and exactly one Site, Zone, or proposed place';END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.client_sites site WHERE site.id=p_site_id AND site.client_organization_id=v_quote.client_org_id AND site.active) THEN RAISE EXCEPTION 'Active Site does not belong to this quote client';END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.location_zones zone WHERE zone.id=p_zone_id AND zone.organization_id=v_quote.client_org_id AND zone.is_active) THEN RAISE EXCEPTION 'Active Zone does not belong to this quote client';END IF;
  IF p_proposed_place_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.quote_proposal_places place WHERE place.id=p_proposed_place_id AND place.quote_id=v_quote.id AND place.module_key=p_module_key) THEN RAISE EXCEPTION 'Proposed place does not belong to this quote and module';END IF;
  SELECT * INTO v_scope FROM public.quote_proposal_service_scopes WHERE quote_id=v_quote.id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_scope;END IF;
  IF p_action='remove' THEN
    DELETE FROM public.quote_proposal_service_scopes WHERE quote_id=v_quote.id AND module_key=p_module_key AND site_id IS NOT DISTINCT FROM p_site_id AND zone_id IS NOT DISTINCT FROM p_zone_id AND proposed_place_id IS NOT DISTINCT FROM p_proposed_place_id RETURNING * INTO v_scope;
    IF NOT FOUND THEN RAISE EXCEPTION 'Proposal service scope not found';END IF;
  ELSE
    INSERT INTO public.quote_proposal_service_scopes(quote_id,module_key,site_id,zone_id,proposed_place_id,client_request_id,created_by) VALUES(v_quote.id,p_module_key,p_site_id,p_zone_id,p_proposed_place_id,p_client_request_id,v_actor) ON CONFLICT(quote_id,module_key,site_id,zone_id,proposed_place_id) DO UPDATE SET module_key=excluded.module_key RETURNING * INTO v_scope;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_quote.provider_org_id,v_actor,'crm_quote_proposal_service_scope_'||p_action,'quote_proposal_service_scopes',v_scope.id,jsonb_build_object('quote_id',v_quote.id,'module_key',p_module_key,'site_id',p_site_id,'zone_id',p_zone_id,'proposed_place_id',p_proposed_place_id));
  RETURN v_scope;
END;$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_service_scopes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE scope public.quote_proposal_service_scopes%rowtype;module_intent public.quote_proposal_modules%rowtype;place public.quote_proposal_places%rowtype;v_site_id uuid;v_zone_id uuid;
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    FOR scope IN SELECT * FROM public.quote_proposal_service_scopes WHERE quote_id=new.id LOOP
      SELECT * INTO module_intent FROM public.quote_proposal_modules WHERE quote_id=new.id AND module_key=scope.module_key;
      IF NOT FOUND THEN RAISE EXCEPTION 'Accepted proposal scope has no quoted module';END IF;
      IF scope.proposed_place_id IS NOT NULL THEN SELECT * INTO place FROM public.quote_proposal_places WHERE id=scope.proposed_place_id;v_site_id:=place.converted_site_id;v_zone_id:=place.converted_zone_id;IF v_site_id IS NULL AND v_zone_id IS NULL THEN RAISE EXCEPTION 'Proposed place was not converted during quote acceptance';END IF;ELSE v_site_id:=scope.site_id;v_zone_id:=scope.zone_id;END IF;
      INSERT INTO public.service_agreement_locations(service_agreement_id,site_id,zone_id,status,created_by) SELECT new.service_agreement_id,v_site_id,v_zone_id,'active',new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.service_agreement_locations location WHERE location.service_agreement_id=new.service_agreement_id AND location.site_id IS NOT DISTINCT FROM v_site_id AND location.zone_id IS NOT DISTINCT FROM v_zone_id);
      INSERT INTO public.site_services(organization_id,service_agreement_id,module_key,site_id,zone_id,service_hours,response_sla_minutes,config,enabled,active,created_by) SELECT new.provider_org_id,new.service_agreement_id,scope.module_key,v_site_id,v_zone_id,module_intent.service_window,module_intent.sla_minutes,jsonb_build_object('proposal_scope_id',scope.id,'pricing_basis',module_intent.pricing_basis,'rate_rule_id',module_intent.rate_rule_id),true,true,new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.site_services service WHERE service.service_agreement_id=new.service_agreement_id AND service.module_key=scope.module_key AND service.site_id IS NOT DISTINCT FROM v_site_id AND service.zone_id IS NOT DISTINCT FROM v_zone_id);
    END LOOP;
  END IF;
  RETURN new;
END;$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_scope_schedules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    INSERT INTO public.service_agreement_delivery_schedules(service_agreement_id,proposal_scope_schedule_id,site_id,zone_id,module_key,capability_key,work_model,active_days,active_months,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,depart_sla_minutes,dwell_minutes,preferred_stop_order,pricing_basis,rate_rule_id,chargeable_conditions,notes,officer_instructions)
    SELECT new.service_agreement_id,schedule.id,coalesce(scope.site_id,place.converted_site_id),coalesce(scope.zone_id,place.converted_zone_id),scope.module_key,schedule.capability_key,schedule.work_model,schedule.active_days,schedule.active_months,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,schedule.window_start,schedule.window_end,schedule.response_sla_minutes,schedule.depart_sla_minutes,schedule.dwell_minutes,schedule.preferred_stop_order,schedule.pricing_basis,schedule.rate_rule_id,schedule.chargeable_conditions,schedule.notes,schedule.officer_instructions FROM public.quote_proposal_scope_schedules schedule JOIN public.quote_proposal_service_scopes scope ON scope.id=schedule.proposal_scope_id LEFT JOIN public.quote_proposal_places place ON place.id=scope.proposed_place_id WHERE scope.quote_id=new.id ON CONFLICT(proposal_scope_schedule_id) DO NOTHING;
  END IF;
  RETURN new;
END;$$;

REVOKE ALL ON FUNCTION public.manage_crm_quote_proposal_service_scope(uuid,uuid,text,text,uuid,uuid,uuid),public.activate_quote_proposal_service_scopes(),public.activate_quote_proposal_scope_schedules() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_proposal_service_scope(uuid,uuid,text,text,uuid,uuid,uuid) TO authenticated,service_role;