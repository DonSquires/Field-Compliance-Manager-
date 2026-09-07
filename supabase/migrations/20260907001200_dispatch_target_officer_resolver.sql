-- Governed provider-tree officer resolver for direct dispatch targeting.

CREATE OR REPLACE FUNCTION public.list_dispatch_target_officers(p_service_agreement_id uuid)
RETURNS TABLE(id uuid, organization_id uuid, display_name text, email text, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.organization_id, u.display_name, u.email, u.role
  FROM public.user_profiles u
  JOIN public.service_agreements sa
    ON sa.id = p_service_agreement_id
  JOIN public.organizations officer_org
    ON officer_org.id = u.organization_id
  WHERE u.deactivated_at IS NULL
    AND u.role IN ('officer', 'admin_officer')
    AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
    AND (
      officer_org.id = sa.provider_organization_id
      OR sa.provider_organization_id = ANY(public.get_descendant_organizations(officer_org.id))
    )
    AND public.org_access_allowed(sa.provider_organization_id)
  ORDER BY coalesce(u.display_name, u.email), u.email;
$$;

REVOKE ALL ON FUNCTION public.list_dispatch_target_officers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_dispatch_target_officers(uuid) TO authenticated, service_role;
