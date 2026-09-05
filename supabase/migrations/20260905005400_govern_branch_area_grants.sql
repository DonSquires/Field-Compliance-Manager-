DROP POLICY IF EXISTS area_grants_write ON public.staff_area_grants;
DROP POLICY IF EXISTS area_grants_select ON public.staff_area_grants;

CREATE POLICY area_grants_select ON public.staff_area_grants FOR SELECT TO authenticated USING (
  user_id = auth.uid() or public.staff_branch_authorisation_manager_can_manage(auth.uid(), scope_org_id, user_id)
);
REVOKE INSERT, UPDATE, DELETE ON public.staff_area_grants FROM authenticated;
GRANT SELECT ON public.staff_area_grants TO authenticated;

CREATE OR REPLACE FUNCTION public.get_branch_area_grants(p_operating_organization_id uuid)
RETURNS TABLE(id uuid, user_id uuid, area text, level text, status text, source_preset text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select area_grant.id, area_grant.user_id, area_grant.area, area_grant.level, area_grant.status, area_grant.source_preset, area_grant.updated_at
  from public.staff_area_grants area_grant
  where area_grant.scope_org_id = p_operating_organization_id
    and public.user_can_operate_organization(p_operating_organization_id)
    and public.staff_branch_authorisation_manager_can_manage(auth.uid(), p_operating_organization_id, area_grant.user_id)
  order by area_grant.updated_at desc;
$$;

CREATE OR REPLACE FUNCTION public.end_branch_area_grant(p_grant_id uuid, p_expected_updated_at timestamptz, p_reason text)
RETURNS public.staff_area_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid(); v_grant public.staff_area_grants%rowtype; v_reason text := nullif(trim(coalesce(p_reason,'')), '');
begin
  if v_reason is null then raise exception 'A change reason is required'; end if;
  select * into v_grant from public.staff_area_grants where id = p_grant_id for update;
  if not found or v_grant.status <> 'active' then raise exception 'Active direct area grant not found'; end if;
  if not public.user_can_operate_organization(v_grant.scope_org_id) or not public.staff_branch_authorisation_manager_can_manage(v_actor, v_grant.scope_org_id, v_grant.user_id) then raise exception 'Not authorised to end this branch area grant'; end if;
  if p_expected_updated_at is not null and v_grant.updated_at <> p_expected_updated_at then raise exception 'Direct area grant changed since it was opened'; end if;
  update public.staff_area_grants set status = 'ended', updated_at = clock_timestamp() where id = v_grant.id returning * into v_grant;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values(v_grant.scope_org_id, v_actor, 'branch_area_grant_ended', 'staff_area_grants', v_grant.id, jsonb_build_object('user_id',v_grant.user_id,'area',v_grant.area,'level',v_grant.level,'reason',v_reason));
  return v_grant;
end;
$$;

REVOKE ALL ON FUNCTION public.get_branch_area_grants(uuid), public.end_branch_area_grant(uuid,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_area_grants(uuid), public.end_branch_area_grant(uuid,timestamptz,text) TO authenticated, service_role;