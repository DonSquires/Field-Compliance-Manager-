CREATE OR REPLACE FUNCTION public.seed_crm_onboarding_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_ledger public.crm_onboarding_ledgers%rowtype;
BEGIN
  IF new.organization_type IN ('client','government','private_enterprise','contractor','department') AND new.parent_organization_id IS NOT NULL AND new.status='prospect' THEN
    INSERT INTO public.crm_onboarding_ledgers(provider_organization_id,account_organization_id)
    VALUES(new.parent_organization_id,new.id)
    ON CONFLICT DO NOTHING RETURNING * INTO v_ledger;
    IF v_ledger.id IS NOT NULL THEN
      INSERT INTO public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,to_stage,ledger_status,note,ledger_version)
      VALUES(v_ledger.id,v_ledger.provider_organization_id,v_ledger.account_organization_id,'started',v_ledger.current_stage,v_ledger.status,'Onboarding ledger created',v_ledger.version);
    END IF;
  END IF;
  RETURN new;
END;
$$;

INSERT INTO public.crm_onboarding_ledgers(provider_organization_id,account_organization_id)
SELECT o.parent_organization_id,o.id
FROM public.organizations o
WHERE o.organization_type IN ('client','government','private_enterprise','contractor','department')
  AND o.parent_organization_id IS NOT NULL
  AND o.status='prospect'
ON CONFLICT DO NOTHING;

INSERT INTO public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version,created_at)
SELECT l.id,l.provider_organization_id,l.account_organization_id,'started',null,l.current_stage,l.status,l.assigned_to,'Onboarding ledger created',null,l.version,l.started_at
FROM public.crm_onboarding_ledgers l
WHERE NOT EXISTS(SELECT 1 FROM public.crm_onboarding_events e WHERE e.ledger_id=l.id);
