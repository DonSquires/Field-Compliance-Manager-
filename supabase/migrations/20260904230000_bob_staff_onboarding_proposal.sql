CREATE OR REPLACE FUNCTION public.apply_bob_staff_onboarding_proposal(p_action_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare a public.bob_agentic_actions%rowtype; sp public.staff_profiles%rowtype; l public.staff_onboarding_ledgers%rowtype; p jsonb; approver public.user_profiles%rowtype;
begin
 select * into a from public.bob_agentic_actions where id=p_action_id for update;
 if not found or a.action_type<>'start_staff_onboarding' or a.status<>'approved' then raise exception 'Only approved start_staff_onboarding actions can be executed'; end if;
 if a.result_record_id is not null then return a.result_record_id; end if;
 select * into approver from public.user_profiles where id=a.approved_by and deactivated_at is null;
 if not found or approver.organization_id<>a.organization_id or not public.is_admin_for_org(a.organization_id) then raise exception 'An active HR administrator approval is required'; end if;
 p:=coalesce(a.amended_payload,a.proposed_payload);
 select * into sp from public.staff_profiles where id=(p->>'staff_id')::uuid and organization_id=a.organization_id for update;
 if not found then raise exception 'Proposed staff profile is unavailable'; end if;
 select * into l from public.staff_onboarding_ledgers where staff_id=sp.id;
 if found then return l.id; end if;
 insert into public.staff_onboarding_ledgers(organization_id,staff_id,assigned_to,target_start,stage_note) values(a.organization_id,sp.id,nullif(p->>'assigned_to','')::uuid,nullif(p->>'target_start','')::date,coalesce(nullif(trim(p->>'note'),''),'Bob proposed onboarding start')) returning * into l;
 insert into public.staff_onboarding_events(ledger_id,organization_id,to_stage,to_status,note,actor_user_id,version) values(l.id,l.organization_id,l.current_stage,l.status,l.stage_note,a.approved_by,l.version);
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(a.organization_id,a.approved_by,'bob_staff_onboarding_started','staff_onboarding_ledgers',l.id,jsonb_build_object('action_id',a.id,'staff_id',sp.id));
 return l.id;
end;$$;
REVOKE ALL ON FUNCTION public.apply_bob_staff_onboarding_proposal(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bob_staff_onboarding_proposal(uuid) TO service_role;
