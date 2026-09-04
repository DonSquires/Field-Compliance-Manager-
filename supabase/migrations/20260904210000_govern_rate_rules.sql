-- Rate rules are shared finance inputs for dispatch pay, roster cost forecasts,
-- CRM billing readiness, callouts, and court time. Browser writes are replaced
-- with one audited, expected-state owner.

DROP POLICY IF EXISTS rate_rules_write ON public.rate_rules;
REVOKE INSERT, UPDATE, DELETE ON public.rate_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rate_rules TO authenticated;

CREATE OR REPLACE FUNCTION public.manage_rate_rule(
  p_client_request_id uuid,
  p_action text,
  p_rate_rule_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_rule_kind text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_rate_type text DEFAULT NULL,
  p_amount numeric DEFAULT NULL,
  p_pay_code text DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_job_type text DEFAULT NULL,
  p_client_org_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_day_category text DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_priority integer DEFAULT 0
)
RETURNS public.rate_rules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_rule public.rate_rules%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active finance administrator required'; end if;

  if p_action = 'create' then
    if v_name is null or p_rule_kind not in ('pay','billing') or p_rate_type not in ('hourly','flat','daily','per_km','per_unit','percentage','per_hour_travel','per_hour_allowance','oncall_flat','callout','higher_duties_flat','per_visit','per_notice') or p_amount is null or p_amount < 0 then
      raise exception 'Rule name, kind, rate type, and a non-negative amount are required';
    end if;
    if p_day_category is not null and p_day_category not in ('weekday','weekend','public_holiday','night') then raise exception 'Unsupported day category'; end if;
    if p_effective_to is not null and p_effective_from is not null and p_effective_to < p_effective_from then raise exception 'Effective end cannot precede effective start'; end if;
    select r.* into v_rule from public.rate_rules r where r.organization_id=v_org and r.client_request_id=p_client_request_id;
    if found then return v_rule; end if;
    insert into public.rate_rules(organization_id,rule_kind,name,rate_type,amount,pay_code,service_type,job_type,client_org_id,site_id,zone_id,day_category,effective_from,effective_to,priority,active,created_by,updated_by,client_request_id)
    values(v_org,p_rule_kind,v_name,p_rate_type,p_amount,nullif(trim(coalesce(p_pay_code,'')),''),nullif(trim(coalesce(p_service_type,'')),''),nullif(trim(coalesce(p_job_type,'')),''),p_client_org_id,p_site_id,p_zone_id,p_day_category,p_effective_from,p_effective_to,coalesce(p_priority,0),true,v_actor,v_actor,p_client_request_id)
    returning * into v_rule;
  else
    select r.* into v_rule from public.rate_rules r where r.id=p_rate_rule_id for update;
    if not found or (v_rule.organization_id<>v_org and not public.is_grand_master()) then raise exception 'Rate rule not found in your organization'; end if;
    if p_expected_updated_at is not null and v_rule.updated_at<>p_expected_updated_at then raise exception 'Rate rule changed since it was opened'; end if;
    if p_action='update' then
      if v_name is null or p_rate_type not in ('hourly','flat','daily','per_km','per_unit','percentage','per_hour_travel','per_hour_allowance','oncall_flat','callout','higher_duties_flat','per_visit','per_notice') or p_amount is null or p_amount<0 then raise exception 'Rule name, rate type, and non-negative amount are required'; end if;
      if p_day_category is not null and p_day_category not in ('weekday','weekend','public_holiday','night') then raise exception 'Unsupported day category'; end if;
      if p_effective_to is not null and p_effective_from is not null and p_effective_to<p_effective_from then raise exception 'Effective end cannot precede effective start'; end if;
      update public.rate_rules set name=v_name,rate_type=p_rate_type,amount=p_amount,pay_code=nullif(trim(coalesce(p_pay_code,'')),''),service_type=nullif(trim(coalesce(p_service_type,'')),''),job_type=nullif(trim(coalesce(p_job_type,'')),''),client_org_id=p_client_org_id,site_id=p_site_id,zone_id=p_zone_id,day_category=p_day_category,effective_from=p_effective_from,effective_to=p_effective_to,priority=coalesce(p_priority,0),updated_by=v_actor where id=v_rule.id returning * into v_rule;
    elsif p_action='deactivate' then
      update public.rate_rules set active=false,updated_by=v_actor where id=v_rule.id and active returning * into v_rule;
      if not found then raise exception 'Rate rule is already inactive'; end if;
    elsif p_action='reactivate' then
      update public.rate_rules set active=true,updated_by=v_actor where id=v_rule.id and not active returning * into v_rule;
      if not found then raise exception 'Rate rule is already active'; end if;
    else raise exception 'Unsupported rate rule action'; end if;
  end if;

  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_rule.organization_id,v_actor,'rate_rule_managed','rate_rules',v_rule.id,jsonb_build_object('action',p_action,'rule_kind',v_rule.rule_kind,'rate_type',v_rule.rate_type,'amount',v_rule.amount,'client_request_id',p_client_request_id));
  return v_rule;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_rate_rule(uuid,text,uuid,timestamptz,text,text,text,numeric,text,text,text,uuid,uuid,uuid,text,date,date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_rate_rule(uuid,text,uuid,timestamptz,text,text,text,numeric,text,text,text,uuid,uuid,uuid,text,date,date,integer) TO authenticated, service_role;
