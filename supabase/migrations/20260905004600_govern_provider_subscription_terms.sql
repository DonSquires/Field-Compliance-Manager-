-- Layer 1 contract overrides: null price/period/currency fields inherit the
-- Iron Eagle catalog. Only the platform owner may change a provider's terms.
CREATE OR REPLACE FUNCTION public.manage_provider_module_subscription_terms(
  p_subscription_id uuid,
  p_expected_updated_at timestamptz,
  p_base_price numeric DEFAULT NULL,
  p_per_seat_price numeric DEFAULT NULL,
  p_per_site_price numeric DEFAULT NULL,
  p_discount_pct numeric DEFAULT 0,
  p_billing_period text DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_to date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.org_module_subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_subscription public.org_module_subscriptions%rowtype;
begin
  if not public.is_grand_master() then raise exception 'Iron Eagle platform owner required'; end if;
  select * into v_subscription from public.org_module_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'Provider module subscription not found'; end if;
  if p_expected_updated_at is not null and v_subscription.updated_at <> p_expected_updated_at then raise exception 'Provider module subscription changed since it was opened'; end if;
  if p_base_price is not null and p_base_price < 0 or p_per_seat_price is not null and p_per_seat_price < 0 or p_per_site_price is not null and p_per_site_price < 0 then raise exception 'Platform price overrides cannot be negative'; end if;
  if p_discount_pct is null or p_discount_pct < 0 or p_discount_pct > 100 then raise exception 'Discount must be between zero and 100 percent'; end if;
  if p_billing_period is not null and p_billing_period not in ('monthly', 'quarterly', 'annual') then raise exception 'Unsupported billing period'; end if;
  if p_currency is not null and p_currency not in ('NZD', 'AUD', 'USD') then raise exception 'Unsupported currency'; end if;
  if p_effective_to is not null and p_effective_from is not null and p_effective_to < p_effective_from then raise exception 'Effective end cannot precede effective start'; end if;
  update public.org_module_subscriptions set base_price=p_base_price,per_seat_price=p_per_seat_price,per_site_price=p_per_site_price,discount_pct=p_discount_pct,billing_period=p_billing_period,currency=p_currency,effective_from=p_effective_from,effective_to=p_effective_to,notes=nullif(trim(coalesce(p_notes,'')),''),updated_by=auth.uid(),updated_at=now() where id=v_subscription.id returning * into v_subscription;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_subscription.organization_id,auth.uid(),'provider_module_subscription_terms_managed','org_module_subscriptions',v_subscription.id,jsonb_build_object('module_key',v_subscription.module_key,'base_price',v_subscription.base_price,'per_seat_price',v_subscription.per_seat_price,'per_site_price',v_subscription.per_site_price,'discount_pct',v_subscription.discount_pct,'billing_period',v_subscription.billing_period,'currency',v_subscription.currency,'effective_from',v_subscription.effective_from,'effective_to',v_subscription.effective_to));
  return v_subscription;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_provider_module_subscription_terms(uuid,timestamptz,numeric,numeric,numeric,numeric,text,text,date,date,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_provider_module_subscription_terms(uuid,timestamptz,numeric,numeric,numeric,numeric,text,text,date,date,text) TO authenticated, service_role;