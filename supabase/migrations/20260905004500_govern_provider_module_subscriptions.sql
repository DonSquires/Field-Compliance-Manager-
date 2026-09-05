-- Layer 1: only Iron Eagle's platform owner can change a provider/branch
-- subscription contract. Module enablement continues to create or suspend lines.
CREATE OR REPLACE FUNCTION public.manage_provider_module_subscription_status(
  p_subscription_id uuid,
  p_expected_updated_at timestamptz,
  p_status text
)
RETURNS public.org_module_subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_subscription public.org_module_subscriptions%rowtype;
begin
  if not public.is_grand_master() then raise exception 'Iron Eagle platform owner required'; end if;
  if p_status not in ('active', 'suspended', 'cancelled') then raise exception 'Unsupported subscription status'; end if;
  select * into v_subscription from public.org_module_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'Provider module subscription not found'; end if;
  if p_expected_updated_at is not null and v_subscription.updated_at <> p_expected_updated_at then raise exception 'Provider module subscription changed since it was opened'; end if;
  if v_subscription.status = 'cancelled' and p_status = 'active' then raise exception 'A cancelled platform subscription requires a new contract'; end if;
  update public.org_module_subscriptions set status = p_status, ended_at = case when p_status = 'cancelled' then current_date else null end, updated_by = v_actor, updated_at = now() where id = v_subscription.id returning * into v_subscription;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_subscription.organization_id,v_actor,'provider_module_subscription_status_managed','org_module_subscriptions',v_subscription.id,jsonb_build_object('module_key',v_subscription.module_key,'status',v_subscription.status));
  return v_subscription;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_provider_module_subscription_status(uuid,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_provider_module_subscription_status(uuid,timestamptz,text) TO authenticated, service_role;