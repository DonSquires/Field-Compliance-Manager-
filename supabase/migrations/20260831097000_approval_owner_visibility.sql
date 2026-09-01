drop function if exists public.get_approvals_activity(integer,integer,text[],text[]);

create function public.get_approvals_activity(p_limit integer default 50,p_offset integer default 0,p_statuses text[] default null::text[],p_action_types text[] default null::text[]) returns table(id uuid,action_type text,status text,bob_reasoning text,confidence_score real,context_table text,context_summary text,created_at timestamptz,applied_at timestamptz,approved_at timestamptz,proposed_payload jsonb,amended_payload jsonb,organization_id uuid,org_name text,triggered_by uuid,triggered_by_name text,user_id uuid,user_name text,approved_by uuid,approved_by_name text,rejection_reason text,error_message text,result_table text,result_record_id uuid,assigned_approver_id uuid,assigned_approver_name text,can_decide boolean)
language plpgsql stable security definer set search_path=public as $$
declare
  v_user_id uuid:=auth.uid();
  v_role text;
  v_org_id uuid;
begin
  if v_user_id is null then return; end if;
  select up.role,up.organization_id into v_role,v_org_id from public.user_profiles up where up.id=v_user_id;
  if v_role is null then return; end if;
  return query
  select a.id,a.action_type,a.status,a.bob_reasoning,a.confidence_score,a.context_table,a.context_summary,a.created_at,a.applied_at,a.approved_at,a.proposed_payload,a.amended_payload,a.organization_id,o.name,
    a.triggered_by,(select up1.display_name from public.user_profiles up1 where up1.id=a.triggered_by),
    a.user_id,(select up2.display_name from public.user_profiles up2 where up2.id=a.user_id),
    a.approved_by,(select up3.display_name from public.user_profiles up3 where up3.id=a.approved_by),
    a.rejection_reason,a.error_message,a.result_table,a.result_record_id,a.assigned_approver_id,
    (select up4.display_name from public.user_profiles up4 where up4.id=a.assigned_approver_id),
    case when a.status not in('pending','pending_approval','proposed') then false when v_role='grand_master' then true when v_role in('master','admin') then public.can_approve_action(v_user_id,a.organization_id) else false end
  from public.bob_agentic_actions a left join public.organizations o on o.id=a.organization_id
  where (a.triggered_by=v_user_id or a.user_id=v_user_id or a.assigned_approver_id=v_user_id or v_role='grand_master' or (v_role in('master','admin') and public.is_admin_for_org(a.organization_id)))
    and (p_statuses is null or a.status=any(p_statuses)) and (p_action_types is null or a.action_type=any(p_action_types))
  order by case when a.status in('pending','proposed','pending_approval') then 0 else 1 end,a.created_at desc limit p_limit offset p_offset;
end;
$$;

comment on function public.get_approvals_activity(integer,integer,text[],text[]) is 'Full-lifecycle approvals activity with explicit assigned decision owner and caller authority.';
revoke all on function public.get_approvals_activity(integer,integer,text[],text[]) from public,anon;
grant execute on function public.get_approvals_activity(integer,integer,text[],text[]) to authenticated,service_role;