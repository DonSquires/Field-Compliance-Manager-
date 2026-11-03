-- Restore tenant import service identities caught by the 20261102140000 access-set sweep.
--
-- The sweep deactivated every profile whose email matched "automation", which
-- included "R&M import automation", the configured import actor for the
-- rm_patrol_log source profile. Since then every nightly workbook promotion has
-- been refused ("Configured import identity is not an active tenant
-- administrator"), so October patrol and camera card-review rows never reached
-- client reports.
--
-- Only a profile that is (a) the import actor of an active import source
-- profile, (b) has no Auth account, so nobody can sign in as it, and (c) was
-- deactivated by that sweep is restored. Human or test accounts stay inactive.

DO $$
DECLARE
	v_profile record;
BEGIN
	FOR v_profile IN
		SELECT u.id, u.organization_id, u.role, u.deactivated_at, sweep.actor_user_id
		FROM public.user_profiles u
		JOIN LATERAL (
			SELECT a.actor_user_id
			FROM public.audit_log a
			WHERE a.target_table = 'user_profiles'
				AND a.target_id = u.id
				AND a.action = 'user_deactivated'
				AND a.metadata ->> 'migration_version' = '20261102140000'
			ORDER BY a.created_at DESC
			LIMIT 1
		) sweep ON true
		WHERE u.deactivated_at IS NOT NULL
			AND EXISTS (
				SELECT 1 FROM public.import_source_profiles p
				WHERE p.import_actor_id = u.id AND p.active
			)
			AND NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.id)
		FOR UPDATE OF u
	LOOP
		UPDATE public.user_profiles
		SET deactivated_at = NULL,
			deactivated_by = NULL,
			updated_at = clock_timestamp()
		WHERE id = v_profile.id;

		INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
		VALUES (
			v_profile.organization_id,
			v_profile.actor_user_id,
			'user_reactivated',
			'user_profiles',
			v_profile.id,
			jsonb_build_object(
				'role', v_profile.role,
				'reason', 'Configured tenant import service identity restored: no sign-in account, and its deactivation by the access-set sweep blocked governed workbook promotion.',
				'previous_deactivated_at', v_profile.deactivated_at,
				'deactivated_at', NULL,
				'auth_account', 'absent',
				'migration_version', '20261104140000'
			)
		);
	END LOOP;
END;
$$;
