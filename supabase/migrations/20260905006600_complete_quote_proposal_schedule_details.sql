ALTER TABLE public.quote_proposal_scope_schedules
  ADD COLUMN IF NOT EXISTS active_months integer[] NOT NULL DEFAULT ARRAY[]::integer[] CHECK (active_months <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]),
  ADD COLUMN IF NOT EXISTS dwell_minutes integer NOT NULL DEFAULT 15 CHECK (dwell_minutes >= 1),
  ADD COLUMN IF NOT EXISTS depart_sla_minutes integer CHECK (depart_sla_minutes IS NULL OR depart_sla_minutes BETWEEN 1 AND 10080),
  ADD COLUMN IF NOT EXISTS preferred_stop_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS officer_instructions text;

ALTER TABLE public.service_agreement_delivery_schedules
  ADD COLUMN IF NOT EXISTS active_months integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  ADD COLUMN IF NOT EXISTS dwell_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS depart_sla_minutes integer,
  ADD COLUMN IF NOT EXISTS preferred_stop_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS officer_instructions text;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_proposal_scope_schedule_details(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_action text,
  p_schedule_id uuid DEFAULT NULL,
  p_proposal_scope_id uuid DEFAULT NULL,
  p_capability_key text DEFAULT NULL,
  p_work_model text DEFAULT NULL,
  p_active_days integer[] DEFAULT ARRAY[1,2,3,4,5,6,7],
  p_active_months integer[] DEFAULT ARRAY[]::integer[],
  p_visits_per_shift integer DEFAULT 1,
  p_min_gap_between_visits_minutes integer DEFAULT 60,
  p_window_start time DEFAULT NULL,
  p_window_end time DEFAULT NULL,
  p_response_sla_minutes integer DEFAULT NULL,
  p_depart_sla_minutes integer DEFAULT NULL,
  p_dwell_minutes integer DEFAULT 15,
  p_preferred_stop_order integer DEFAULT 0,
  p_rate_rule_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_officer_instructions text DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL
)
RETURNS public.quote_proposal_scope_schedules LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare
  v_schedule public.quote_proposal_scope_schedules%rowtype;
begin
  if p_action not in ('create','update','remove') then raise exception 'Valid proposal schedule action is required'; end if;
  if p_action='remove' then
    return public.manage_crm_quote_proposal_scope_schedule(p_client_request_id,p_quote_id,'remove',p_schedule_id,null,null,null,null,1,0,null,null,null,'quote_lines',null,'{}'::jsonb,null,p_expected_updated_at);
  end if;
  if coalesce(p_active_months,ARRAY[]::integer[]) !<@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]
    or coalesce(p_dwell_minutes,0)<1
    or (p_depart_sla_minutes is not null and p_depart_sla_minutes not between 1 and 10080) then
    raise exception 'Valid seasonal, dwell, and departure SLA schedule details are required';
  end if;
  v_schedule:=public.manage_crm_quote_proposal_scope_schedule(
    p_client_request_id,p_quote_id,p_action,p_schedule_id,p_proposal_scope_id,p_capability_key,p_work_model,
    p_active_days,p_visits_per_shift,p_min_gap_between_visits_minutes,p_window_start,p_window_end,p_response_sla_minutes,
    case when p_rate_rule_id is null then 'quote_lines' else 'standard_rate_rule' end,p_rate_rule_id,
    case when p_capability_key='alarm_response' then jsonb_build_object('chargeable',true) else '{}'::jsonb end,
    p_notes,p_expected_updated_at
  );
  update public.quote_proposal_scope_schedules
  set active_months=coalesce(p_active_months,ARRAY[]::integer[]),dwell_minutes=p_dwell_minutes,
      depart_sla_minutes=p_depart_sla_minutes,preferred_stop_order=coalesce(p_preferred_stop_order,0),
      officer_instructions=nullif(trim(coalesce(p_officer_instructions,'')),''),updated_at=clock_timestamp()
  where id=v_schedule.id returning * into v_schedule;
  return v_schedule;
end;$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_scope_schedules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
begin
  if new.status='accepted' and new.service_agreement_id is not null and old.status is distinct from 'accepted' then
    insert into public.service_agreement_delivery_schedules(
      service_agreement_id,proposal_scope_schedule_id,site_id,zone_id,module_key,capability_key,work_model,
      active_days,active_months,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,
      response_sla_minutes,depart_sla_minutes,dwell_minutes,preferred_stop_order,pricing_basis,rate_rule_id,
      chargeable_conditions,notes,officer_instructions
    )
    select new.service_agreement_id,schedule.id,scope.site_id,scope.zone_id,scope.module_key,schedule.capability_key,
      schedule.work_model,schedule.active_days,schedule.active_months,schedule.visits_per_shift,
      schedule.min_gap_between_visits_minutes,schedule.window_start,schedule.window_end,schedule.response_sla_minutes,
      schedule.depart_sla_minutes,schedule.dwell_minutes,schedule.preferred_stop_order,schedule.pricing_basis,
      schedule.rate_rule_id,schedule.chargeable_conditions,schedule.notes,schedule.officer_instructions
    from public.quote_proposal_scope_schedules schedule
    join public.quote_proposal_service_scopes scope on scope.id=schedule.proposal_scope_id
    where scope.quote_id=new.id
    on conflict(proposal_scope_schedule_id) do nothing;
  end if;
  return new;
end;$$;

REVOKE ALL ON FUNCTION public.manage_crm_quote_proposal_scope_schedule_details(uuid,uuid,text,uuid,uuid,text,text,integer[],integer[],integer,integer,time,time,integer,integer,integer,integer,uuid,text,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_proposal_scope_schedule_details(uuid,uuid,text,uuid,uuid,text,text,integer[],integer[],integer,integer,time,time,integer,integer,integer,integer,uuid,text,text,timestamptz) TO authenticated,service_role;
