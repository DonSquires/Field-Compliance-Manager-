-- Enforcement officers may initiate/maintain notices, but ordinary client
-- relationship visibility must not grant write authority. This helper is the
-- precise write boundary for module enforcement tables.
CREATE OR REPLACE FUNCTION public.is_enforcement_operator_for_org(target_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer')
      AND (
        p.role = 'grand_master'
        OR target_org_id = p.organization_id
        OR target_org_id = ANY(public.get_descendant_organizations(p.organization_id))
        OR (p.employer_organization_id IS NOT NULL
            AND target_org_id = ANY(public.get_descendant_organizations(p.employer_organization_id)))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_enforcement_operator_for_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_enforcement_operator_for_org(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS infringement_notices_insert ON public.infringement_notices;
CREATE POLICY infringement_notices_insert ON public.infringement_notices
  FOR INSERT TO authenticated
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));
DROP POLICY IF EXISTS infringement_notices_update ON public.infringement_notices;
CREATE POLICY infringement_notices_update ON public.infringement_notices
  FOR UPDATE TO authenticated
  USING (public.is_enforcement_operator_for_org(organization_id))
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));

DROP POLICY IF EXISTS notices_to_vacate_insert ON public.notices_to_vacate;
CREATE POLICY notices_to_vacate_insert ON public.notices_to_vacate
  FOR INSERT TO authenticated
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));
DROP POLICY IF EXISTS notices_to_vacate_update ON public.notices_to_vacate;
CREATE POLICY notices_to_vacate_update ON public.notices_to_vacate
  FOR UPDATE TO authenticated
  USING (public.is_enforcement_operator_for_org(organization_id))
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));

DROP POLICY IF EXISTS pin_insert ON public.parking_infringement_notices;
CREATE POLICY pin_insert ON public.parking_infringement_notices
  FOR INSERT TO authenticated
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));
DROP POLICY IF EXISTS pin_update ON public.parking_infringement_notices;
CREATE POLICY pin_update ON public.parking_infringement_notices
  FOR UPDATE TO authenticated
  USING (public.is_enforcement_operator_for_org(organization_id))
  WITH CHECK (public.is_enforcement_operator_for_org(organization_id));
