create or replace function public.tg_align_module_subscription()
  returns trigger
  language plpgsql
  security definer
  AS $function$
declare
  v_org_type text;
begin
  -- Only act when the enabled flag is set (INSERT) or actually changed (UPDATE).
  if tg_op = 'UPDATE' and (new.enabled is not distinct from old.enabled) then
    return new;
  end if;

  select organization_type into v_org_type
  from public.organizations
  where id = new.organization_id;

  -- Layer 1 bills providers only. Non-provider orgs no-op.
  if v_org_type is null or v_org_type not in ('service_provider', 'branch') then
    return new;
  end if;

  if new.enabled then
    -- Create or reactivate the line. Preserve any existing per-provider overrides
    -- (only status/updated_at are forced; price columns are left untouched).
    insert into public.org_module_subscriptions (organization_id, module_key, status)
    values (new.organization_id, new.module_key, 'active')
    on conflict (organization_id, module_key) do update
      set status = case
                     when public.org_module_subscriptions.status = 'cancelled'
                       then public.org_module_subscriptions.status  -- do not silently revive a cancelled contract
                     else 'active'
                   end,
          updated_at = now();
  else
    -- Disable => suspend the line (never delete; keeps overrides + history).
    update public.org_module_subscriptions
       set status = 'suspended', updated_at = now()
     where organization_id = new.organization_id
       and module_key = new.module_key
       and status <> 'cancelled';
  end if;

  return new;
end $function$;

grant execute on function "public"."tg_align_module_subscription"() to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."tg_align_module_subscription"() is 'B2 (#2): aligns org_module_subscriptions with organization_modules enablement for billable provider tiers (service_provider|branch). Preserves overrides; suspends (never deletes) on disable; does not revive cancelled contracts.';
