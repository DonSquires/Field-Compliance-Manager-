CREATE OR REPLACE FUNCTION private.rnm_admin_for_organization(p_target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM public.user_profiles actor
		WHERE actor.id = (SELECT auth.uid())
			AND actor.deactivated_at IS NULL
			AND actor.role IN ('admin', 'admin_officer', 'master', 'grand_master')
			AND p_target_organization_id IS NOT NULL
			AND (
				p_target_organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
				OR p_target_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
			)
			AND (
				actor.role = 'grand_master'
				OR actor.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
				OR actor.organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
				OR actor.employer_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
			)
			AND public.is_admin_for_org(p_target_organization_id)
	);
$function$;
