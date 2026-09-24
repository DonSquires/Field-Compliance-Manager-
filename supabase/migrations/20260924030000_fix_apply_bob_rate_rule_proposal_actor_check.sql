-- Fixes a real, systemic bug found 2026-09-24 while live-verifying R&M's
-- finance/km pipeline: bob-proposal-execute (supabase/functions/bob-proposal-execute)
-- invokes apply_bob_rate_rule_proposal via a SERVICE-ROLE client (by design -
-- "the executor is service-role-only", per that function's own doc comment),
-- so auth.uid() is always NULL inside this function. The old body's admin
-- check called is_admin_for_org(v_action.organization_id), which resolves
-- entirely from auth.uid() - meaning the check ALWAYS failed with "An active
-- finance administrator approval is required", for every org, every user,
-- every time, regardless of who actually approved the action. Reproduced
-- live: a real R&M master (Don Squires) approved a real rate-rule proposal
-- in the live UI and the apply step failed with exactly this error.
--
-- Fix: use can_approve_action(p_user_id, p_action_org_id) - already built,
-- already used earlier in the SAME approve/apply flow
-- (supabase/functions/bob-proposal-approver calls it with an explicit
-- p_user_id) - parameterized by the actual approver (v_action.approved_by,
-- already fetched and validated into v_actor above) instead of auth.uid().
-- Everything else in the function body is byte-identical to the prior
-- version.

CREATE OR REPLACE FUNCTION "public"."apply_bob_rate_rule_proposal"(p_action_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_actor public.user_profiles%rowtype;
  v_rule public.rate_rules%rowtype;
begin
  select * into v_action from public.bob_agentic_actions where id=p_action_id for update;
  if not found or v_action.action_type<>'create_rate_rule' or v_action.status<>'approved' then raise exception 'Only approved create_rate_rule actions can be executed'; end if;
  if v_action.result_record_id is not null then return v_action.result_record_id; end if;
  select * into v_actor from public.user_profiles where id=v_action.approved_by and deactivated_at is null;
  if not found or v_actor.organization_id<>v_action.organization_id or not public.can_approve_action(v_action.approved_by, v_action.organization_id) then raise exception 'An active finance administrator approval is required'; end if;
  v_payload:=coalesce(v_action.amended_payload,v_action.proposed_payload);
  if nullif(trim(coalesce(v_payload->>'name','')),'') is null or v_payload->>'rule_kind' not in ('pay','billing') or v_payload->>'rate_type' not in ('hourly','flat','daily','per_km','per_unit','percentage','per_hour_travel','per_hour_allowance','oncall_flat','callout','higher_duties_flat','per_visit','per_notice') or (v_payload->>'amount')::numeric<0 then raise exception 'Approved rate-rule proposal is invalid'; end if;
  insert into public.rate_rules(organization_id,rule_kind,name,rate_type,amount,pay_code,service_type,job_type,day_category,priority,active,created_by,updated_by,client_request_id)
  values(v_action.organization_id,v_payload->>'rule_kind',trim(v_payload->>'name'),v_payload->>'rate_type',(v_payload->>'amount')::numeric,nullif(trim(coalesce(v_payload->>'pay_code','')),''),nullif(trim(coalesce(v_payload->>'service_type','')),''),nullif(trim(coalesce(v_payload->>'job_type','')),''),nullif(trim(coalesce(v_payload->>'day_category','')),''),coalesce((v_payload->>'priority')::integer,0),true,v_action.approved_by,v_action.approved_by,gen_random_uuid()) returning * into v_rule;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_rule.organization_id,v_action.approved_by,'bob_rate_rule_proposal_applied','rate_rules',v_rule.id,jsonb_build_object('action_id',v_action.id));
  return v_rule.id;
end;
$function$;
