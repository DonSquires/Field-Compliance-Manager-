DROP POLICY IF EXISTS rate_rules_select ON public.rate_rules;
CREATE POLICY rate_rules_select ON public.rate_rules FOR SELECT TO authenticated USING (
  public.is_grand_master()
  OR public.user_can_operate_organization(organization_id)
);
REVOKE INSERT, UPDATE, DELETE ON public.rate_rules FROM authenticated;
GRANT SELECT ON public.rate_rules TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_operate_organization(uuid) TO authenticated;