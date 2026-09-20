-- The account list's readiness and 'next action' (get_crm_organization_readiness) counted operational work the same
-- static-only way the agreement readiness did: a patrol run rostered from the agreement's accepted schedules did not
-- count, so an activated parking-patrol account still read 'Create an operational work unit'. Same rule as
-- 20260920100000, and only live agreements count.

CREATE OR REPLACE FUNCTION "public"."get_crm_organization_readiness"(p_organization_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(organization_id uuid, organization_status text, identity_status text, contact_status text, location_status text, agreement_status text, module_status text, billing_status text, operations_status text, blockers text[], next_action text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
BEGIN
  SELECT actor.organization_id INTO v_provider
  FROM public.user_profiles actor
  WHERE actor.id = v_actor AND actor.deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  RETURN QUERY
  WITH accounts AS (
    SELECT o.*
    FROM public.organizations o
    WHERE o.parent_organization_id = ANY(public.get_descendant_organizations(v_provider))
      AND (p_organization_ids IS NULL OR o.id = ANY(p_organization_ids))
  ), facts AS (
    SELECT
      a.id,
      a.status,
      (a.name <> '' AND a.organization_type IS NOT NULL) AS identity_ready,
      EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = a.id AND c.is_primary AND c.deactivated_at IS NULL) AS contact_ready,
      EXISTS(SELECT 1 FROM public.client_sites s WHERE s.client_organization_id = a.id AND s.active) AS location_ready,
      EXISTS(
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND sa.invitation_status = 'accepted'
      ) AS agreement_ready,
      EXISTS(
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND sa.invitation_status = 'accepted'
          AND cardinality(sa.enabled_modules) > 0
      ) AS module_ready,
      EXISTS(
        SELECT 1
        FROM public.service_agreements sa
        JOIN public.crm_commercial_settings cc ON cc.service_agreement_id = sa.id
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
      ) AS billing_ready,
      EXISTS(
        -- a static post attributed to a covered place, or a patrol run whose stops come from an accepted schedule
        SELECT 1
        FROM public.roster_work_units wu
        JOIN public.service_agreements sa ON (
          sa.id = (SELECT sal.service_agreement_id FROM public.service_agreement_locations sal WHERE sal.id = wu.service_agreement_location_id)
          OR sa.id IN (SELECT s.service_agreement_id FROM public.client_site_patrol_config c JOIN public.service_agreement_delivery_schedules s ON s.proposal_scope_schedule_id = c.proposal_scope_schedule_id WHERE c.patrol_route_id = wu.patrol_route_id AND c.active AND s.active)
        )
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
          AND wu.active
      ) AS operations_ready
    FROM accounts a
  )
  SELECT
    f.id,
    f.status,
    CASE WHEN f.identity_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.contact_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.location_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.agreement_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.module_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.billing_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.operations_ready THEN 'ready' ELSE 'blocked' END,
    array_remove(ARRAY[
      CASE WHEN NOT f.identity_ready THEN 'Confirm the organization identity' END,
      CASE WHEN NOT f.contact_ready THEN 'Add a primary contact' END,
      CASE WHEN NOT f.location_ready THEN 'Add an active covered site' END,
      CASE WHEN NOT f.agreement_ready THEN 'Create and accept a service agreement' END,
      CASE WHEN NOT f.module_ready THEN 'Enable at least one agreement module' END,
      CASE WHEN NOT f.billing_ready THEN 'Complete commercial settings' END,
      CASE WHEN NOT f.operations_ready THEN 'Create an operational work unit' END
    ], NULL),
    CASE
      WHEN NOT f.contact_ready THEN 'Add primary contact'
      WHEN NOT f.location_ready THEN 'Add covered site'
      WHEN NOT f.agreement_ready THEN 'Create service agreement'
      WHEN NOT f.module_ready THEN 'Enable service modules'
      WHEN NOT f.billing_ready THEN 'Complete billing setup'
      WHEN NOT f.operations_ready THEN 'Complete operational setup'
      ELSE 'Ready for activation review'
    END
  FROM facts f
  ORDER BY f.id;
END;
$$;

