CREATE TABLE public.quote_proposal_scope_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_scope_id uuid NOT NULL REFERENCES public.quote_proposal_service_scopes(id) ON DELETE CASCADE,
  capability_key text NOT NULL CHECK (capability_key IN ('patrol','noise_control','static_guarding','freedom_camping','alarm_response')),
  work_model text NOT NULL CHECK (work_model IN ('scheduled_patrol','scheduled_static','on_demand_callout','inspection_or_notice','recurring_service')),
  active_days integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7] CHECK (active_days <@ ARRAY[1,2,3,4,5,6,7]),
  visits_per_shift integer NOT NULL DEFAULT 1 CHECK (visits_per_shift >= 1),
  min_gap_between_visits_minutes integer NOT NULL DEFAULT 60 CHECK (min_gap_between_visits_minutes >= 0),
  window_start time, window_end time,
  response_sla_minutes integer CHECK (response_sla_minutes IS NULL OR response_sla_minutes BETWEEN 1 AND 10080),
  pricing_basis text NOT NULL DEFAULT 'quote_lines' CHECK (pricing_basis IN ('quote_lines','standard_rate_rule','site_override_pending')),
  rate_rule_id uuid REFERENCES public.rate_rules(id) ON DELETE RESTRICT,
  chargeable_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  client_request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(proposal_scope_id,client_request_id)
);
CREATE TRIGGER trg_quote_proposal_scope_schedules_touch BEFORE UPDATE ON public.quote_proposal_scope_schedules FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
ALTER TABLE public.quote_proposal_scope_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_proposal_scope_schedules_select ON public.quote_proposal_scope_schedules FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.quote_proposal_service_scopes scope JOIN public.quotes quote ON quote.id=scope.quote_id WHERE scope.id=proposal_scope_id AND public.org_access_allowed(quote.provider_org_id)));
REVOKE ALL ON public.quote_proposal_scope_schedules FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.quote_proposal_scope_schedules TO authenticated;
GRANT ALL ON public.quote_proposal_scope_schedules TO service_role;

CREATE TABLE public.service_agreement_delivery_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE CASCADE,
  proposal_scope_schedule_id uuid UNIQUE REFERENCES public.quote_proposal_scope_schedules(id) ON DELETE SET NULL,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT, zone_id uuid,
  module_key text NOT NULL, capability_key text NOT NULL, work_model text NOT NULL,
  active_days integer[] NOT NULL, visits_per_shift integer NOT NULL, min_gap_between_visits_minutes integer NOT NULL,
  window_start time, window_end time, response_sla_minutes integer, pricing_basis text NOT NULL, rate_rule_id uuid REFERENCES public.rate_rules(id) ON DELETE RESTRICT,
  chargeable_conditions jsonb NOT NULL DEFAULT '{}'::jsonb, notes text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_agreement_delivery_schedules_place_xor CHECK ((site_id IS NOT NULL) <> (zone_id IS NOT NULL))
);
ALTER TABLE public.service_agreement_delivery_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_agreement_delivery_schedules_select ON public.service_agreement_delivery_schedules FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.service_agreements agreement WHERE agreement.id=service_agreement_id AND public.org_access_allowed(agreement.provider_organization_id)));
REVOKE ALL ON public.service_agreement_delivery_schedules FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.service_agreement_delivery_schedules TO authenticated;
GRANT ALL ON public.service_agreement_delivery_schedules TO service_role;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_proposal_scope_schedule(p_client_request_id uuid,p_quote_id uuid,p_action text,p_schedule_id uuid DEFAULT NULL,p_proposal_scope_id uuid DEFAULT NULL,p_capability_key text DEFAULT NULL,p_work_model text DEFAULT NULL,p_active_days integer[] DEFAULT ARRAY[1,2,3,4,5,6,7],p_visits_per_shift integer DEFAULT 1,p_min_gap_between_visits_minutes integer DEFAULT 60,p_window_start time DEFAULT NULL,p_window_end time DEFAULT NULL,p_response_sla_minutes integer DEFAULT NULL,p_pricing_basis text DEFAULT 'quote_lines',p_rate_rule_id uuid DEFAULT NULL,p_chargeable_conditions jsonb DEFAULT '{}'::jsonb,p_notes text DEFAULT NULL,p_expected_updated_at timestamptz DEFAULT NULL)
RETURNS public.quote_proposal_scope_schedules LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_scope public.quote_proposal_service_scopes%rowtype;v_schedule public.quote_proposal_scope_schedules%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;select * into v_quote from public.quotes where id=p_quote_id for update;if not found or not public.is_admin_for_org(v_quote.provider_org_id) or v_quote.status<>'draft' then raise exception 'Draft quote administration required';end if;
  if p_action='remove' then select schedule.* into v_schedule from public.quote_proposal_scope_schedules schedule join public.quote_proposal_service_scopes scope on scope.id=schedule.proposal_scope_id where schedule.id=p_schedule_id and scope.quote_id=v_quote.id for update;if not found then raise exception 'Proposal schedule not found';end if;if p_expected_updated_at is not null and v_schedule.updated_at<>p_expected_updated_at then raise exception 'Proposal schedule changed since it was opened';end if;delete from public.quote_proposal_scope_schedules where id=v_schedule.id returning * into v_schedule;
  else
    if p_action not in('create','update') or p_capability_key not in('patrol','noise_control','static_guarding','freedom_camping','alarm_response') or p_work_model not in('scheduled_patrol','scheduled_static','on_demand_callout','inspection_or_notice','recurring_service') or not (coalesce(p_active_days,ARRAY[]::integer[]) <@ ARRAY[1,2,3,4,5,6,7]) or coalesce(p_visits_per_shift,0)<1 or coalesce(p_min_gap_between_visits_minutes,-1)<0 or (p_response_sla_minutes is not null and p_response_sla_minutes not between 1 and 10080) or p_pricing_basis not in('quote_lines','standard_rate_rule','site_override_pending') then raise exception 'Valid delivery schedule details are required';end if;
    if p_work_model='scheduled_patrol' and p_capability_key not in('patrol','freedom_camping') then raise exception 'Scheduled patrol delivery requires patrol or freedom camping capability';end if;if p_capability_key='alarm_response' and p_work_model<>'on_demand_callout' then raise exception 'Alarm response is an on-demand callout capability';end if;
    if p_action='create' then select * into v_scope from public.quote_proposal_service_scopes where id=p_proposal_scope_id and quote_id=v_quote.id;if not found then raise exception 'Proposal place scope not found';end if;select * into v_schedule from public.quote_proposal_scope_schedules where proposal_scope_id=v_scope.id and client_request_id=p_client_request_id;if found then return v_schedule;end if;insert into public.quote_proposal_scope_schedules(proposal_scope_id,capability_key,work_model,active_days,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,pricing_basis,rate_rule_id,chargeable_conditions,notes,client_request_id,created_by)values(v_scope.id,p_capability_key,p_work_model,p_active_days,p_visits_per_shift,p_min_gap_between_visits_minutes,p_window_start,p_window_end,p_response_sla_minutes,p_pricing_basis,p_rate_rule_id,coalesce(p_chargeable_conditions,'{}'::jsonb),nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor)returning * into v_schedule;
    else select schedule.* into v_schedule from public.quote_proposal_scope_schedules schedule join public.quote_proposal_service_scopes scope on scope.id=schedule.proposal_scope_id where schedule.id=p_schedule_id and scope.quote_id=v_quote.id for update;if not found then raise exception 'Proposal schedule not found';end if;if p_expected_updated_at is not null and v_schedule.updated_at<>p_expected_updated_at then raise exception 'Proposal schedule changed since it was opened';end if;update public.quote_proposal_scope_schedules set capability_key=p_capability_key,work_model=p_work_model,active_days=p_active_days,visits_per_shift=p_visits_per_shift,min_gap_between_visits_minutes=p_min_gap_between_visits_minutes,window_start=p_window_start,window_end=p_window_end,response_sla_minutes=p_response_sla_minutes,pricing_basis=p_pricing_basis,rate_rule_id=p_rate_rule_id,chargeable_conditions=coalesce(p_chargeable_conditions,'{}'::jsonb),notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=clock_timestamp() where id=v_schedule.id returning * into v_schedule;end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_quote.provider_org_id,v_actor,'crm_quote_proposal_scope_schedule_'||p_action,'quote_proposal_scope_schedules',v_schedule.id,jsonb_build_object('quote_id',v_quote.id,'proposal_scope_id',v_schedule.proposal_scope_id,'capability_key',v_schedule.capability_key,'work_model',v_schedule.work_model));return v_schedule;
end;$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_scope_schedules() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
begin
  if new.status='accepted' and new.service_agreement_id is not null and old.status is distinct from 'accepted' then insert into public.service_agreement_delivery_schedules(service_agreement_id,proposal_scope_schedule_id,site_id,zone_id,module_key,capability_key,work_model,active_days,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,pricing_basis,rate_rule_id,chargeable_conditions,notes) select new.service_agreement_id,schedule.id,scope.site_id,scope.zone_id,scope.module_key,schedule.capability_key,schedule.work_model,schedule.active_days,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,schedule.window_start,schedule.window_end,schedule.response_sla_minutes,schedule.pricing_basis,schedule.rate_rule_id,schedule.chargeable_conditions,schedule.notes from public.quote_proposal_scope_schedules schedule join public.quote_proposal_service_scopes scope on scope.id=schedule.proposal_scope_id where scope.quote_id=new.id on conflict(proposal_scope_schedule_id) do nothing;end if;return new;
end;$$;
CREATE TRIGGER trg_activate_quote_proposal_scope_schedules AFTER UPDATE OF status ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.activate_quote_proposal_scope_schedules();
REVOKE ALL ON FUNCTION public.manage_crm_quote_proposal_scope_schedule(uuid,uuid,text,uuid,uuid,text,text,integer[],integer,integer,time,time,integer,text,uuid,jsonb,text,timestamptz),public.activate_quote_proposal_scope_schedules() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_proposal_scope_schedule(uuid,uuid,text,uuid,uuid,text,text,integer[],integer,integer,time,time,integer,text,uuid,jsonb,text,timestamptz) TO authenticated,service_role;
