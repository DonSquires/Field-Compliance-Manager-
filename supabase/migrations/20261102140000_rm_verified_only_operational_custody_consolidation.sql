CREATE TABLE private.platform_tenancy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  service_provider_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  platform_owner_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  configured_by uuid NOT NULL,
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ruling text NOT NULL
);

CREATE TABLE private.org_consolidation_transfers (
  migration_version text NOT NULL,
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  source_organization_id uuid,
  destination_organization_id uuid,
  source_actor_id uuid,
  source_recorded_at timestamptz,
  source_row_sha256 text NOT NULL,
  transfer_basis text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (migration_version, entity_table, entity_id)
);

COMMENT ON TABLE private.platform_tenancy IS
  'Single-provider tenancy boundary: R&M is the only service provider; Iron Eagle is the platform owner.';
COMMENT ON TABLE private.org_consolidation_transfers IS
  'Append-only provenance for verified custody transfers. The source row remains in place and changes only organization_id; hashes exclude organization_id and updated_at.';

ALTER TABLE private.platform_tenancy ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.org_consolidation_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.platform_tenancy FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.org_consolidation_transfers FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_enforcement_operator_for_org(target_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    WHERE p.id = auth.uid()
      AND p.deactivated_at IS NULL
      AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer')
      AND (
        p.role = 'grand_master'
        OR target_org_id = p.organization_id
        OR target_org_id = ANY(public.get_descendant_organizations(p.organization_id))
        OR (p.employer_organization_id IS NOT NULL
            AND target_org_id = ANY(public.get_descendant_organizations(p.employer_organization_id)))
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.is_enforcement_operator_for_org(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_enforcement_operator_for_org(uuid) TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_user_deactivation(
  p_target_user_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor public.user_profiles%ROWTYPE;
  v_target public.user_profiles%ROWTYPE;
  v_new_deactivated_at timestamptz;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_sessions_revoked integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_target_user_id IS NULL OR p_action IS NULL OR p_action NOT IN ('deactivate', 'reactivate') THEN
    RAISE EXCEPTION 'A target user and valid action are required';
  END IF;

  SELECT p.*
  INTO v_actor
  FROM public.user_profiles p
  WHERE p.id = auth.uid()
    AND p.deactivated_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_actor.role NOT IN ('grand_master', 'master', 'admin', 'admin_officer', 'client_admin') THEN
    RAISE EXCEPTION 'Active user administrator required';
  END IF;

  SELECT p.*
  INTO v_target
  FROM public.user_profiles p
  WHERE p.id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;
  IF v_actor.role <> 'grand_master' AND v_target.organization_id IS DISTINCT FROM v_actor.organization_id THEN
    RAISE EXCEPTION 'Cannot manage users from other organizations';
  END IF;
  IF v_actor.role = 'client_admin' AND left(v_target.role, 7) <> 'client_' THEN
    RAISE EXCEPTION 'A client administrator can only manage client users';
  END IF;
  IF v_target.id = v_actor.id THEN
    RAISE EXCEPTION 'Cannot deactivate your own account';
  END IF;
  IF v_target.role = 'grand_master' AND v_actor.role <> 'grand_master' THEN
    RAISE EXCEPTION 'Cannot deactivate grand master users';
  END IF;
  IF p_action = 'deactivate' AND v_target.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'User is already deactivated';
  END IF;
  IF p_action = 'reactivate' AND v_target.deactivated_at IS NULL THEN
    RAISE EXCEPTION 'User is already active';
  END IF;

  v_new_deactivated_at := CASE
    WHEN p_action = 'deactivate' THEN clock_timestamp()
    ELSE NULL
  END;

  UPDATE public.user_profiles
  SET deactivated_at = v_new_deactivated_at,
      deactivated_by = CASE WHEN v_new_deactivated_at IS NULL THEN NULL ELSE v_actor.id END,
      updated_at = clock_timestamp()
  WHERE id = v_target.id;

  -- A ban stops sign-in and refresh; deleting sessions makes Auth reject access tokens already issued.
  IF p_action = 'deactivate' THEN
    UPDATE auth.users
    SET banned_until = clock_timestamp() + interval '100 years'
    WHERE id = v_target.id;

    DELETE FROM auth.sessions
    WHERE user_id = v_target.id;
    GET DIAGNOSTICS v_sessions_revoked = ROW_COUNT;
  ELSE
    UPDATE auth.users
    SET banned_until = NULL
    WHERE id = v_target.id;
  END IF;

  -- user_management_audit keys its target to auth.users; roster-only profiles are audited in audit_log.
  IF EXISTS (SELECT 1 FROM auth.users au WHERE au.id = v_target.id) THEN
    PERFORM public.log_user_management_action(
      v_target.organization_id,
      v_target.id,
      CASE WHEN p_action = 'deactivate' THEN 'user_deactivated' ELSE 'user_reactivated' END,
      v_actor.id,
      jsonb_build_object('role', v_target.role, 'deactivated_at', v_target.deactivated_at),
      jsonb_build_object('role', v_target.role, 'deactivated_at', v_new_deactivated_at),
      jsonb_strip_nulls(jsonb_build_object(
        'display_name', v_target.display_name,
        'role', v_target.role,
        'reason', v_reason,
        'auth_sessions_revoked', v_sessions_revoked
      ))
    );
  ELSE
    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    )
    VALUES (
      v_target.organization_id,
      v_actor.id,
      CASE WHEN p_action = 'deactivate' THEN 'user_deactivated' ELSE 'user_reactivated' END,
      'user_profiles',
      v_target.id,
      jsonb_strip_nulls(jsonb_build_object(
        'display_name', v_target.display_name,
        'role', v_target.role,
        'reason', v_reason,
        'previous_deactivated_at', v_target.deactivated_at,
        'deactivated_at', v_new_deactivated_at,
        'auth_account', 'absent'
      ))
    );
  END IF;

  RETURN v_new_deactivated_at;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_user_deactivation(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_user_deactivation(uuid, text, text) TO authenticated;

-- Deleted sessions stop Auth and Edge Functions immediately, but PostgREST trusts an unexpired JWT
-- by signature alone. Every RLS role helper must therefore fail closed for a deactivated profile.
CREATE OR REPLACE FUNCTION public.current_account_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.deactivated_at IS NOT NULL
  );
$function$;
COMMENT ON FUNCTION public.current_account_is_active() IS
  'False when the calling Auth user has a deactivated profile. Backs restrictive RLS guards so an unexpired access token cannot outlive deactivation.';
REVOKE ALL ON FUNCTION public.current_account_is_active() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_account_is_active() TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT role
  FROM public.user_profiles
  WHERE id = auth.uid()
    AND deactivated_at IS NULL
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.is_master_or_above()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = auth.uid()
      AND deactivated_at IS NULL
      AND role IN ('grand_master', 'master')
  );
$function$;

CREATE OR REPLACE FUNCTION public.user_managed_branch_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(array_agg(sba.branch_org_id), ARRAY[]::uuid[])
  FROM public.staff_branch_authorisations sba
  JOIN public.user_profiles p
    ON p.id = sba.user_id
   AND p.deactivated_at IS NULL
  WHERE sba.user_id = auth.uid()
    AND sba.status = 'active'
    AND sba.role_at_branch = 'branch_manager';
$function$;

CREATE OR REPLACE FUNCTION public.wf_has_role(_role public.wf_app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.wf_user_roles ur
    JOIN public.user_profiles p
      ON p.id = ur.user_id
     AND p.deactivated_at IS NULL
    WHERE ur.user_id = (SELECT auth.uid())
      AND ur.role = _role
  );
$function$;

-- Policies also hand auth.uid() to helpers as an argument. Task entitlement (observations and the
-- assessment tables) and platform-owner checks (bob_self_memory) must fail closed for a deactivated
-- profile too, otherwise assignments or an owner email outlive deactivation for the token lifetime.
CREATE OR REPLACE FUNCTION public.user_has_task_entitlement(
  p_user uuid DEFAULT auth.uid(),
  p_observation_id uuid DEFAULT NULL::uuid,
  p_noise_assessment_id uuid DEFAULT NULL::uuid,
  p_smoke_assessment_id uuid DEFAULT NULL::uuid,
  p_biosecurity_assessment_id uuid DEFAULT NULL::uuid,
  p_incident_id uuid DEFAULT NULL::uuid,
  p_notice_id uuid DEFAULT NULL::uuid,
  p_enforcement_case_id uuid DEFAULT NULL::uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.user_profiles p
      WHERE p.id = p_user
        AND p.deactivated_at IS NOT NULL
    ) THEN false
    ELSE coalesce(
      (public.resolve_access_basis(
          p_user, p_observation_id, p_noise_assessment_id, p_smoke_assessment_id,
          p_biosecurity_assessment_id, p_incident_id, p_notice_id, p_enforcement_case_id
       ) ->> 'decision_state') NOT IN ('no_task_entitlement', 'hard_stop'),
      false
    )
  END;
$function$;
COMMENT ON FUNCTION public.user_has_task_entitlement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) IS
  'STRICT BOOLEAN for RLS (ACCESS_MODEL.md section 8). Derived from resolve_access_basis so boolean and UI object can never disagree. SECURITY DEFINER + fixed search_path (0326). 0329: p_user defaults to auth.uid(); the self-only guard lives in resolve_access_basis. 20261102140000: false for a deactivated profile, so task assignments cannot outlive deactivation.';

CREATE OR REPLACE FUNCTION public.is_platform_owner(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_email text;
begin
  if exists (
    select 1
    from public.user_profiles p
    where p.id = p_user_id
      and p.deactivated_at is not null
  ) then
    return false;
  end if;

  -- Resolve email from auth.users (the authoritative identity store).
  select lower(trim(email)) into v_email
  from auth.users
  where id = p_user_id;

  -- Fail-closed: no auth row or no email => not an owner.
  if v_email is null or v_email = '' then
    return false;
  end if;

  -- Canonical owner emails (mirrors supabase/functions/_shared/auth.ts OWNER_EMAILS).
  return v_email in (
    'don.squires@firstsecurity.co.nz',
    'squires.don@live.com',
    'squires.don@gmail.com'
  );
end;
$function$;
COMMENT ON FUNCTION public.is_platform_owner(uuid) IS
  'Returns true iff the given user_profiles.id resolves to a platform-owner email in auth.users and the profile is not deactivated. Fail-closed: no auth row, no email, or a deactivated profile => false. Mirrors OWNER_EMAILS from supabase/functions/_shared/auth.ts.';

-- These tables carry policies that read user_profiles inline without checking deactivation.
DO $guards$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'access_presets',
    'dispatch_job_pay_lines',
    'geo_source_registry',
    'location_notes',
    'onboarding_invites',
    'org_engagements',
    'org_module_subscriptions',
    'org_rate_settings',
    'organizations',
    'payroll_export_batches',
    'preset_assignments',
    'quote_lines',
    'quotes',
    'reference_codes',
    'service_agreement_locations',
    'sla_discount_bands',
    'staff_reporting',
    'staff_training_records',
    'team_members',
    'teams',
    'tenders'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      RAISE EXCEPTION 'Deactivation guard target public.% does not exist', v_table;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS deactivated_account_guard ON public.%I', v_table);
    EXECUTE format(
      'CREATE POLICY deactivated_account_guard ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.current_account_is_active())) '
      'WITH CHECK ((SELECT public.current_account_is_active()))',
      v_table
    );
  END LOOP;
END;
$guards$;

CREATE OR REPLACE FUNCTION public.propagate_group_charge_catalog_to_child()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin')
    AND current_setting('app.rm_custody_transfer', true) = '20261102140000' THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_organization_id IS NOT NULL THEN
    PERFORM public.sync_group_charge_catalog(NEW.parent_organization_id, NEW.id);
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.propagate_group_charge_catalog_to_child() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propagate_group_charge_catalog_to_child() TO postgres;

CREATE OR REPLACE FUNCTION public.propagate_group_charge_catalog_to_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin')
    AND current_setting('app.rm_custody_transfer', true) = '20261102140000' THEN
    RETURN NEW;
  END IF;

  IF NEW.client_organization_id IS NOT NULL
    AND NEW.agreement_type = 'operational'
    AND (NEW.ends_on IS NULL OR NEW.ends_on >= current_date) THEN
    PERFORM public.sync_group_charge_catalog(
      NEW.provider_organization_id,
      NEW.client_organization_id
    );
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.propagate_group_charge_catalog_to_client() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propagate_group_charge_catalog_to_client() TO postgres;

INSERT INTO private.platform_tenancy (
  singleton,
  service_provider_organization_id,
  platform_owner_organization_id,
  configured_by,
  ruling
)
VALUES (
  true,
  'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',
  '56710c19-d604-4767-9ad8-9c5863b4ceb7',
  '1b02ab97-8611-40ab-a3a0-b5c74589db58',
  'Owner ruling 2026-11-01: R&M is the sole service provider; Iron Eagle retains platform and billing ownership.'
)
ON CONFLICT (singleton) DO NOTHING;

DO $migration$
DECLARE
  v_rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_iron_eagle uuid := '56710c19-d604-4767-9ad8-9c5863b4ceb7';
  v_actor uuid := '1b02ab97-8611-40ab-a3a0-b5c74589db58';
  v_count integer;
  v_expected integer;
  v_updated integer;
  v_hash_mismatches integer;
  v_table text;
  v_sql text;
  v_profile record;
  v_deactivation_reason text;
  v_new_authorisations uuid[];
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Custody consolidation must run through the privileged migration lane';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM private.platform_tenancy t
    WHERE t.singleton
      AND t.service_provider_organization_id = v_rm
      AND t.platform_owner_organization_id = v_iron_eagle
      AND t.configured_by = v_actor
  ) THEN
    RAISE EXCEPTION 'Single-provider tenancy configuration conflicts with the approved R&M/Iron Eagle identities';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = v_rm
      AND o.organization_type = 'service_provider'
      AND o.active
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = v_iron_eagle
      AND o.organization_type = 'owner'
      AND o.active
  ) THEN
    RAISE EXCEPTION 'Expected active R&M provider and Iron Eagle owner records were not found';
  END IF;

  IF (
    SELECT count(*)
    FROM public.organizations
    WHERE organization_type = 'owner'
      AND active
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active platform owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles u
    WHERE u.id = v_actor
      AND u.organization_id = v_iron_eagle
      AND u.role = 'grand_master'
      AND u.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Verified human migration actor is not an active Iron Eagle grand master';
  END IF;

  IF (
    SELECT count(*)
    FROM public.service_agreements sa
    WHERE sa.provider_organization_id = v_iron_eagle
      AND sa.client_organization_id = v_rm
      AND sa.agreement_type = 'financial'
      AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
      AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one current Iron Eagle to R&M platform billing agreement';
  END IF;

  CREATE TEMP TABLE fcm_verified_agreements (
    agreement_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_verified_agreements (agreement_id)
  VALUES
    ('3572df19-fdfb-476c-8f33-aa91111d0bc5'),
    ('c7e29b21-baff-484e-97f8-eb4438332b4e'),
    ('c3126149-0021-4e51-b1be-208e4ca2c1fd'),
    ('a9b7e259-9b1d-4f61-9be6-cc2a5c9a0287'),
    ('474958ad-f41b-4652-8a0d-c9ece3566612'),
    ('c506e8b0-b59d-46c8-9fda-d844aef77b3f');

  SELECT count(*) INTO v_count
  FROM pg_temp.fcm_verified_agreements v
  JOIN public.service_agreements sa ON sa.id = v.agreement_id
  WHERE sa.agreement_type = 'operational'
    AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= current_date);

  IF v_count <> 6 THEN
    RAISE EXCEPTION 'Verified legacy agreement set changed: expected 6 current operational agreements, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.service_agreements sa
    WHERE (sa.id IN (
        '3572df19-fdfb-476c-8f33-aa91111d0bc5',
        'c7e29b21-baff-484e-97f8-eb4438332b4e'
      ) AND sa.provider_organization_id <> '0a44987e-3556-469a-8274-7f5af1594f5c')
      OR (sa.id = 'c3126149-0021-4e51-b1be-208e4ca2c1fd'
        AND sa.provider_organization_id <> '8b860f57-83ce-4f95-aca3-df30522f0388')
      OR (sa.id = 'a9b7e259-9b1d-4f61-9be6-cc2a5c9a0287'
        AND sa.provider_organization_id <> 'd3d0702e-6147-4bad-8ad9-8b34f15cbf9e')
      OR (sa.id IN (
        '474958ad-f41b-4652-8a0d-c9ece3566612',
        'c506e8b0-b59d-46c8-9fda-d844aef77b3f'
      ) AND sa.provider_organization_id <> '46fa050e-4f76-4dc6-9dd2-7a9b6a827e67')
  ) THEN
    RAISE EXCEPTION 'Verified legacy agreement ownership changed; refusing to guess';
  END IF;

  CREATE TEMP TABLE fcm_client_organizations (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_client_organizations (organization_id)
  SELECT o.id
  FROM public.organizations o
  WHERE o.active
    AND o.id NOT IN (v_rm, v_iron_eagle)
    AND o.organization_type IN ('client', 'government', 'private_enterprise')
    AND o.name !~* '(test|e2e|fixture|example|sample|verification|demo|sandbox|bob document pdf)'
  UNION
  SELECT sa.client_organization_id
  FROM pg_temp.fcm_verified_agreements v
  JOIN public.service_agreements sa ON sa.id = v.agreement_id
  JOIN public.organizations o ON o.id = sa.client_organization_id
  WHERE o.id NOT IN (v_rm, v_iron_eagle)
    AND o.name !~* '(test|e2e|fixture|example|sample|verification|demo|sandbox|bob document pdf)'
  UNION
  SELECT sa.client_organization_id
  FROM public.service_agreements sa
  JOIN public.organizations o ON o.id = sa.client_organization_id
  WHERE sa.provider_organization_id = v_rm
    AND sa.agreement_type = 'operational'
    AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
    AND o.id NOT IN (v_rm, v_iron_eagle)
    AND o.name !~* '(test|e2e|fixture|example|sample|verification|demo|sandbox|bob document pdf)';

  IF NOT EXISTS (
    SELECT 1 FROM pg_temp.fcm_client_organizations
    WHERE organization_id = '46fa050e-4f76-4dc6-9dd2-7a9b6a827e67'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_temp.fcm_client_organizations
    WHERE organization_id = 'ae297f06-1c15-478a-9337-5704b3522d5b'
  ) THEN
    RAISE EXCEPTION 'LINZ or NMDHB client identity is missing from the verified client set';
  END IF;

  CREATE TEMP TABLE fcm_preexisting_rm_tree (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_preexisting_rm_tree (organization_id)
  WITH RECURSIVE rm_tree AS (
    SELECT v_rm AS id
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN rm_tree parent ON child.parent_organization_id = parent.id
  )
  SELECT id FROM rm_tree;

  INSERT INTO private.org_consolidation_transfers (
    migration_version, entity_table, entity_id, source_organization_id,
    destination_organization_id, source_actor_id, source_recorded_at,
    source_row_sha256, transfer_basis, recorded_by
  )
  SELECT
    '20261102140000',
    'organizations',
    o.id,
    o.parent_organization_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM pg_temp.fcm_preexisting_rm_tree tree
        WHERE tree.organization_id = o.parent_organization_id
      ) THEN o.parent_organization_id
      ELSE v_rm
    END,
    NULL,
    o.updated_at,
    encode(extensions.digest(
      convert_to((to_jsonb(o) - 'updated_at')::text, 'UTF8'),
      'sha256'
    ), 'hex'),
    'verified_client_identity_reparented',
    v_actor
  FROM pg_temp.fcm_client_organizations c
  JOIN public.organizations o ON o.id = c.organization_id
  WHERE o.organization_type IS DISTINCT FROM 'client'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_temp.fcm_preexisting_rm_tree tree
      WHERE tree.organization_id = o.parent_organization_id
    )
    OR EXISTS (
      SELECT 1
      FROM pg_temp.fcm_verified_agreements v
      JOIN public.service_agreements sa ON sa.id = v.agreement_id
      WHERE sa.client_organization_id = o.id
        AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
        AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
        AND (NOT o.active OR o.status IS DISTINCT FROM 'active')
    );

  PERFORM pg_catalog.set_config('app.rm_custody_transfer', '20261102140000', true);

  UPDATE public.organizations o
  SET organization_type = 'client',
      parent_organization_id = CASE
        WHEN EXISTS (
          SELECT 1
          FROM pg_temp.fcm_preexisting_rm_tree tree
          WHERE tree.organization_id = o.parent_organization_id
        ) THEN o.parent_organization_id
        ELSE v_rm
      END,
      active = CASE
        WHEN EXISTS (
          SELECT 1
          FROM pg_temp.fcm_verified_agreements v
          JOIN public.service_agreements sa ON sa.id = v.agreement_id
          WHERE sa.client_organization_id = o.id
            AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
            AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
        ) THEN true
        ELSE o.active
      END,
      status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM pg_temp.fcm_verified_agreements v
          JOIN public.service_agreements sa ON sa.id = v.agreement_id
          WHERE sa.client_organization_id = o.id
            AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
            AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
        ) THEN 'active'
        ELSE o.status
      END,
      updated_at = clock_timestamp()
  FROM pg_temp.fcm_client_organizations c
  WHERE o.id = c.organization_id
    AND (
      o.organization_type IS DISTINCT FROM 'client'
      OR NOT EXISTS (
        SELECT 1
        FROM pg_temp.fcm_preexisting_rm_tree tree
        WHERE tree.organization_id = o.parent_organization_id
      )
      OR EXISTS (
        SELECT 1
        FROM pg_temp.fcm_verified_agreements v
        JOIN public.service_agreements sa ON sa.id = v.agreement_id
        WHERE sa.client_organization_id = o.id
          AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
          AND (NOT o.active OR o.status IS DISTINCT FROM 'active')
      )
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  SELECT count(*) INTO v_expected
  FROM private.org_consolidation_transfers
  WHERE migration_version = '20261102140000'
    AND entity_table = 'organizations'
    AND transfer_basis = 'verified_client_identity_reparented';
  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'Client reparent count mismatch: expected %, updated %', v_expected, v_updated;
  END IF;

  PERFORM pg_catalog.set_config('app.rm_custody_transfer', '', true);

  CREATE TEMP TABLE fcm_source_organizations (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_source_organizations (organization_id)
  WITH RECURSIVE legacy_provider_tree AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.organization_type = 'service_provider'
      AND o.id <> v_rm
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN legacy_provider_tree parent ON child.parent_organization_id = parent.id
  )
  SELECT id FROM legacy_provider_tree
  UNION
  SELECT v_iron_eagle
  UNION
  SELECT sa.provider_organization_id
  FROM pg_temp.fcm_verified_agreements v
  JOIN public.service_agreements sa ON sa.id = v.agreement_id;

  CREATE TEMP TABLE fcm_archived_organizations (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_archived_organizations (organization_id)
  WITH RECURSIVE legacy_provider_tree AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.organization_type = 'service_provider'
      AND o.id <> v_rm
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN legacy_provider_tree parent ON child.parent_organization_id = parent.id
  )
  SELECT id FROM legacy_provider_tree
  UNION
  SELECT o.id
  FROM public.organizations o
  WHERE o.id NOT IN (v_rm, v_iron_eagle)
    AND o.name ~* '(test|e2e|fixture|example|sample|verification|demo|sandbox|bob document pdf)';

  INSERT INTO private.org_consolidation_transfers (
    migration_version, entity_table, entity_id, source_organization_id,
    destination_organization_id, source_actor_id, source_recorded_at,
    source_row_sha256, transfer_basis, recorded_by
  )
  SELECT
    '20261102140000',
    'organizations',
    o.id,
    o.id,
    NULL,
    NULL,
    o.updated_at,
    encode(extensions.digest(
      convert_to((to_jsonb(o) - 'updated_at')::text, 'UTF8'),
      'sha256'
    ), 'hex'),
    'legacy_provider_or_test_organization_archived',
    v_actor
  FROM pg_temp.fcm_archived_organizations a
  JOIN public.organizations o ON o.id = a.organization_id
  WHERE o.active OR o.status IS DISTINCT FROM 'archived';

  UPDATE public.organizations o
  SET active = false,
      status = 'archived',
      updated_at = clock_timestamp()
  FROM pg_temp.fcm_archived_organizations a
  WHERE o.id = a.organization_id
    AND (o.active OR o.status IS DISTINCT FROM 'archived');

  CREATE TEMP TABLE fcm_retained_user_organizations (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_retained_user_organizations (organization_id)
  WITH RECURSIVE retained_tree(organization_id) AS (
    SELECT v_rm
    UNION
    SELECT v_iron_eagle
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN retained_tree parent
      ON child.parent_organization_id = parent.organization_id
    WHERE child.organization_type IN ('branch', 'contractor')
  )
  SELECT tree.organization_id
  FROM retained_tree tree
  JOIN public.organizations organization_record
    ON organization_record.id = tree.organization_id
  WHERE organization_record.active;

  FOR v_profile IN
    SELECT u.id, u.organization_id, u.role, u.email
    FROM public.user_profiles u
    WHERE u.deactivated_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1
          FROM pg_temp.fcm_retained_user_organizations retained
          WHERE retained.organization_id = u.organization_id
        )
        OR coalesce(u.email, '') ~* '(test|e2e|fixture|example|qa|automation)'
      )
    FOR UPDATE
  LOOP
    v_deactivation_reason := CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM pg_temp.fcm_retained_user_organizations retained
        WHERE retained.organization_id = v_profile.organization_id
      )
        THEN 'Account is seated outside the R&M/Iron Eagle organisation trees; external seats are inactive until formally invited.'
      ELSE 'Test or automation account is excluded from the initial R&M/Iron Eagle access set.'
    END;

    -- user_management_audit keys its target to auth.users; roster-only profiles are audited in audit_log.
    IF EXISTS (SELECT 1 FROM auth.users au WHERE au.id = v_profile.id) THEN
      PERFORM public.log_user_management_action(
        v_profile.organization_id,
        v_profile.id,
        'user_deactivated',
        v_actor,
        jsonb_build_object('role', v_profile.role, 'deactivated_at', NULL),
        jsonb_build_object('role', v_profile.role, 'deactivated_at', clock_timestamp()),
        jsonb_build_object('reason', v_deactivation_reason)
      );
    ELSE
      INSERT INTO public.audit_log (
        organization_id, actor_user_id, action, target_table, target_id, metadata
      )
      VALUES (
        v_profile.organization_id,
        v_actor,
        'user_deactivated',
        'user_profiles',
        v_profile.id,
        jsonb_build_object(
          'role', v_profile.role,
          'reason', v_deactivation_reason,
          'deactivated_at', clock_timestamp(),
          'auth_account', 'absent',
          'migration_version', '20261102140000'
        )
      );
    END IF;

    UPDATE public.user_profiles
    SET deactivated_at = clock_timestamp(),
        deactivated_by = v_actor,
        updated_at = clock_timestamp()
    WHERE id = v_profile.id;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.user_profiles u
    WHERE u.deactivated_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1
          FROM pg_temp.fcm_retained_user_organizations retained
          WHERE retained.organization_id = u.organization_id
        )
        OR coalesce(u.email, '') ~* '(test|e2e|fixture|example|qa|automation)'
      )
  ) THEN
    RAISE EXCEPTION 'Active user profiles remain outside the approved R&M/Iron Eagle account set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.users au
    LEFT JOIN public.user_profiles u ON u.id = au.id
    WHERE u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Unprofiled Auth accounts require explicit reconciliation before account deactivation';
  END IF;

  -- Auth must agree with the profile boundary, including profiles deactivated before this migration.
  UPDATE auth.users au
  SET banned_until = clock_timestamp() + interval '100 years'
  FROM public.user_profiles u
  WHERE u.id = au.id
    AND u.deactivated_at IS NOT NULL
    AND (au.banned_until IS NULL OR au.banned_until < clock_timestamp() + interval '99 years');

  DELETE FROM auth.sessions s
  USING public.user_profiles u
  WHERE u.id = s.user_id
    AND u.deactivated_at IS NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM public.user_profiles u
    JOIN auth.users au ON au.id = u.id
    WHERE u.deactivated_at IS NOT NULL
      AND (au.banned_until IS NULL
        OR au.banned_until <= clock_timestamp()
        OR EXISTS (SELECT 1 FROM auth.sessions s WHERE s.user_id = u.id))
  ) THEN
    RAISE EXCEPTION 'Deactivated profiles still hold usable Auth access';
  END IF;

  FOR v_profile IN
    SELECT u.id, u.organization_id, u.authorized_organization_ids
    FROM public.user_profiles u
    WHERE u.deactivated_at IS NULL
      AND u.organization_id IN (SELECT organization_id FROM pg_temp.fcm_client_organizations)
      AND EXISTS (
        SELECT 1
        FROM unnest(u.authorized_organization_ids) authorized_id
        JOIN pg_temp.fcm_archived_organizations a
          ON a.organization_id = authorized_id
      )
    FOR UPDATE
  LOOP
    SELECT coalesce(
      array_agg(authorized_id ORDER BY ordinal),
      '{}'::uuid[]
    )
    INTO v_new_authorisations
    FROM unnest(v_profile.authorized_organization_ids) WITH ORDINALITY AS requested(authorized_id, ordinal)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_temp.fcm_archived_organizations a
      WHERE a.organization_id = requested.authorized_id
    );

    PERFORM public.log_user_management_action(
      v_profile.organization_id,
      v_profile.id,
      'authorised_organisations_restricted',
      v_actor,
      jsonb_build_object('authorized_organization_ids', v_profile.authorized_organization_ids),
      jsonb_build_object('authorized_organization_ids', v_new_authorisations),
      jsonb_build_object('reason', 'Remove archived provider and test organisation access from retained accounts')
    );

    UPDATE public.user_profiles
    SET authorized_organization_ids = v_new_authorisations,
        updated_at = clock_timestamp()
    WHERE id = v_profile.id;
  END LOOP;

  CREATE TEMP TABLE fcm_verified_actors (
    actor_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_verified_actors (actor_id)
  SELECT u.id
  FROM public.user_profiles u
  WHERE u.deactivated_at IS NULL
    AND u.email IS NOT NULL
    AND u.id <> '00000000-0000-0000-0000-00000000b0b0'
    AND u.email !~* '(test|e2e|fixture|example|qa|automation)';

  CREATE TEMP TABLE fcm_rm_organization_tree (
    organization_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_rm_organization_tree (organization_id)
  WITH RECURSIVE rm_tree AS (
    SELECT v_rm AS id
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN rm_tree parent ON child.parent_organization_id = parent.id
  )
  SELECT id FROM rm_tree;

  PERFORM pg_catalog.set_config('app.rm_custody_transfer', '20261102140000', true);

  INSERT INTO private.org_consolidation_transfers (
    migration_version, entity_table, entity_id, source_organization_id,
    destination_organization_id, source_actor_id, source_recorded_at,
    source_row_sha256, transfer_basis, recorded_by
  )
  SELECT
    '20261102140000',
    'service_agreements',
    sa.id,
    sa.provider_organization_id,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.service_agreements current_rm
      WHERE current_rm.provider_organization_id = v_rm
        AND current_rm.client_organization_id = sa.client_organization_id
        AND current_rm.agreement_type = 'operational'
        AND (current_rm.starts_on IS NULL OR current_rm.starts_on <= current_date)
        AND (current_rm.ends_on IS NULL OR current_rm.ends_on >= current_date)
    ) THEN NULL ELSE v_rm END,
    NULL,
    sa.created_at,
    encode(extensions.digest(
      convert_to((to_jsonb(sa) - 'updated_at')::text, 'UTF8'),
      'sha256'
    ), 'hex'),
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.service_agreements current_rm
      WHERE current_rm.provider_organization_id = v_rm
        AND current_rm.client_organization_id = sa.client_organization_id
        AND current_rm.agreement_type = 'operational'
        AND (current_rm.starts_on IS NULL OR current_rm.starts_on <= current_date)
        AND (current_rm.ends_on IS NULL OR current_rm.ends_on >= current_date)
    ) THEN 'duplicate_legacy_agreement_ended'
      ELSE 'verified_client_agreement_provider_reassigned'
    END,
    v_actor
  FROM pg_temp.fcm_verified_agreements v
  JOIN public.service_agreements sa ON sa.id = v.agreement_id;

  UPDATE public.service_agreements sa
  SET ends_on = CASE
        WHEN sa.starts_on > current_date THEN sa.starts_on - 1
        ELSE current_date - 1
      END
  FROM pg_temp.fcm_verified_agreements v
  WHERE sa.id = v.agreement_id
    AND EXISTS (
      SELECT 1
      FROM public.service_agreements current_rm
      WHERE current_rm.provider_organization_id = v_rm
        AND current_rm.client_organization_id = sa.client_organization_id
        AND current_rm.id <> sa.id
        AND current_rm.agreement_type = 'operational'
        AND (current_rm.starts_on IS NULL OR current_rm.starts_on <= current_date)
        AND (current_rm.ends_on IS NULL OR current_rm.ends_on >= current_date)
    );

  UPDATE public.service_agreements sa
  SET provider_organization_id = v_rm
  FROM pg_temp.fcm_verified_agreements v
  WHERE sa.id = v.agreement_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.service_agreements current_rm
      WHERE current_rm.provider_organization_id = v_rm
        AND current_rm.client_organization_id = sa.client_organization_id
        AND current_rm.id <> sa.id
        AND current_rm.agreement_type = 'operational'
        AND (current_rm.starts_on IS NULL OR current_rm.starts_on <= current_date)
        AND (current_rm.ends_on IS NULL OR current_rm.ends_on >= current_date)
    );

  PERFORM pg_catalog.set_config('app.rm_custody_transfer', '', true);

  INSERT INTO private.org_consolidation_transfers (
    migration_version, entity_table, entity_id, source_organization_id,
    destination_organization_id, source_actor_id, source_recorded_at,
    source_row_sha256, transfer_basis, recorded_by
  )
  SELECT
    '20261102140000',
    'service_agreements',
    sa.id,
    sa.provider_organization_id,
    NULL,
    NULL,
    sa.created_at,
    encode(extensions.digest(
      convert_to((to_jsonb(sa) - 'updated_at')::text, 'UTF8'),
      'sha256'
    ), 'hex'),
    CASE
      WHEN sa.agreement_type = 'operational' THEN 'unverified_or_out_of_tree_operational_agreement_ended'
      ELSE 'non_rm_financial_agreement_ended'
    END,
    v_actor
  FROM public.service_agreements sa
  WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
    AND (
      (
        sa.agreement_type = 'operational'
        AND (
          NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.provider_organization_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.client_organization_id
          )
          OR EXISTS (
            SELECT 1 FROM pg_temp.fcm_archived_organizations a
            WHERE a.organization_id = sa.client_organization_id
          )
        )
      )
      OR (
        sa.agreement_type = 'financial'
        AND NOT (
          sa.provider_organization_id = v_iron_eagle
          AND sa.client_organization_id = v_rm
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM private.org_consolidation_transfers prior
      WHERE prior.migration_version = '20261102140000'
        AND prior.entity_table = 'service_agreements'
        AND prior.entity_id = sa.id
    );

  UPDATE public.service_agreements sa
  SET ends_on = CASE
        WHEN sa.starts_on > current_date THEN sa.starts_on - 1
        ELSE current_date - 1
      END
  WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
    AND (
      (
        sa.agreement_type = 'operational'
        AND (
          NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.provider_organization_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.client_organization_id
          )
          OR EXISTS (
            SELECT 1 FROM pg_temp.fcm_archived_organizations a
            WHERE a.organization_id = sa.client_organization_id
          )
        )
      )
      OR (
        sa.agreement_type = 'financial'
        AND NOT (
          sa.provider_organization_id = v_iron_eagle
          AND sa.client_organization_id = v_rm
        )
      )
    );

  IF EXISTS (
    SELECT 1
    FROM public.service_agreements sa
    WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      AND (
        (sa.agreement_type = 'operational' AND (
          NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.provider_organization_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM pg_temp.fcm_rm_organization_tree t
            WHERE t.organization_id = sa.client_organization_id
          )
          OR EXISTS (
            SELECT 1 FROM pg_temp.fcm_archived_organizations a
            WHERE a.organization_id = sa.client_organization_id
          )
        ))
        OR (sa.agreement_type = 'financial' AND NOT (
          sa.provider_organization_id = v_iron_eagle
          AND sa.client_organization_id = v_rm
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Active or future agreements remain outside the approved R&M/Iron Eagle tenancy';
  END IF;

  CREATE TEMP TABLE fcm_verified_transfer_stage (
    entity_table text NOT NULL,
    entity_id uuid NOT NULL,
    source_organization_id uuid NOT NULL,
    destination_organization_id uuid NOT NULL,
    source_actor_id uuid,
    source_recorded_at timestamptz,
    source_row_sha256 text NOT NULL,
    transfer_basis text NOT NULL,
    PRIMARY KEY (entity_table, entity_id)
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'cctv_imports', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_import_actor'
  FROM public.cctv_imports t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by
  JOIN public.locations house ON house.id = t.location_id
  WHERE t.canonical_place_id = house.canonical_place_id
    AND t.camera_label = trim(t.camera_label)
    AND t.camera_key = left(t.location_id::text, 8) || ':' ||
      coalesce(
        nullif(trim(both '-' from regexp_replace(lower(t.camera_label), '[^a-z0-9]+', '-', 'g')), ''),
        'camera'
      );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'file_import_batches', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_import_actor'
  FROM public.file_import_batches t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'investigations', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_investigation_actor'
  FROM public.investigations t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'biosecurity_assessments', t.id, t.organization_id, v_rm,
    coalesce(t.officer_user_id, t.officer_id), t.assessed_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_field_actor'
  FROM public.biosecurity_assessments t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = coalesce(t.officer_user_id, t.officer_id);

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'noise_assessments', t.id, t.organization_id, v_rm,
    coalesce(t.officer_user_id, t.officer_id), t.assessed_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_field_actor'
  FROM public.noise_assessments t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = coalesce(t.officer_user_id, t.officer_id);

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'smoke_assessments', t.id, t.organization_id, v_rm,
    coalesce(t.officer_user_id, t.officer_id), t.assessed_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_field_actor'
  FROM public.smoke_assessments t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = coalesce(t.officer_user_id, t.officer_id);

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'officer_field_reports', t.id, t.organization_id, v_rm, t.officer_id, t.reported_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_field_actor'
  FROM public.officer_field_reports t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'observations', t.id, t.organization_id, v_rm, t.officer_id, t.observed_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_field_actor'
  FROM public.observations t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'location_events', t.id, t.organization_id, v_rm, t.created_by, t.occurred_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_event_actor'
  FROM public.location_events t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by
  WHERE t.checkpoint_id IS NULL;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'entity_flags', t.id, t.organization_id, v_rm, t.raised_by, t.raised_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_flag_actor'
  FROM public.entity_flags t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.raised_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'entity_links', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_entity_link_actor'
  FROM public.entity_links t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'welfare_alerts', t.id, t.organization_id, v_rm, t.officer_user_id, t.triggered_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_welfare_actor'
  FROM public.welfare_alerts t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_user_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'welfare_checks', t.id, t.organization_id, v_rm, t.officer_user_id, t.checked_in_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_welfare_actor'
  FROM public.welfare_checks t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_user_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'court_appearances', t.id, t.organization_id, v_rm, t.officer_user_id, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_courtwork_actor'
  FROM public.court_appearances t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_user_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'parking_chalk_records', t.id, t.organization_id, v_rm, t.officer_id, t.chalked_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_parking_actor'
  FROM public.parking_chalk_records t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'parking_infringement_notices', t.id, t.organization_id, v_rm, t.issued_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_notice_actor'
  FROM public.parking_infringement_notices t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.issued_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'cctv_device_events', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_cctv_import'
  FROM public.cctv_device_events t
  JOIN pg_temp.fcm_verified_transfer_stage i
    ON i.entity_table = 'cctv_imports'
    AND i.entity_id = t.cctv_import_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'evidence_items', t.id, t.organization_id, v_rm,
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_actors a WHERE a.actor_id = t.captured_by_user_id
    ) THEN t.captured_by_user_id ELSE NULL END,
    t.captured_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_temp.fcm_verified_transfer_stage i
        WHERE i.entity_table = 'cctv_imports' AND i.entity_id = t.cctv_import_id
      ) THEN 'verified_cctv_import'
      WHEN EXISTS (
        SELECT 1 FROM pg_temp.fcm_verified_transfer_stage e
        WHERE e.entity_table = 'location_events' AND e.entity_id = t.location_event_id
      ) THEN 'verified_location_event'
      ELSE 'verified_evidence_actor'
    END
  FROM public.evidence_items t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE t.locked_at IS NULL
    AND (t.evidence_kind <> 'photo' OR t.module_key = 'cctv_review')
    AND (t.location_event_id IS NULL OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_transfer_stage e
      WHERE e.entity_table = 'location_events' AND e.entity_id = t.location_event_id
    ))
    AND (t.cctv_import_id IS NULL OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_transfer_stage i
      WHERE i.entity_table = 'cctv_imports' AND i.entity_id = t.cctv_import_id
    ))
    AND (
      EXISTS (
        SELECT 1 FROM pg_temp.fcm_verified_actors a WHERE a.actor_id = t.captured_by_user_id
      )
      OR EXISTS (
        SELECT 1 FROM pg_temp.fcm_verified_transfer_stage i
        WHERE i.entity_table = 'cctv_imports' AND i.entity_id = t.cctv_import_id
      )
      OR EXISTS (
        SELECT 1 FROM pg_temp.fcm_verified_transfer_stage e
        WHERE e.entity_table = 'location_events' AND e.entity_id = t.location_event_id
      )
    )
    AND NOT (
      t.evidence_kind IN ('photo', 'video')
      AND t.sha256_hash IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.evidence_items existing
        WHERE existing.organization_id IN (
          SELECT organization_id FROM pg_temp.fcm_source_organizations
          UNION
          SELECT v_rm
        )
          AND existing.evidence_kind = t.evidence_kind
          AND lower(existing.sha256_hash) = lower(t.sha256_hash)
          AND existing.id <> t.id
      )
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'cctv_entity_observations', t.id, t.organization_id, v_rm, t.reviewed_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_vehicle_or_animal_observation'
  FROM public.cctv_entity_observations t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage i
    ON i.entity_table = 'cctv_imports'
    AND i.entity_id = t.cctv_import_id
  JOIN pg_temp.fcm_verified_transfer_stage e
    ON e.entity_table = 'evidence_items'
    AND e.entity_id = t.evidence_item_id
  WHERE t.entity_kind IN ('vehicle', 'animal');

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'cctv_observation_derivatives', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_vehicle_or_animal_observation'
  FROM public.cctv_observation_derivatives t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage o
    ON o.entity_table = 'cctv_entity_observations'
    AND o.entity_id = t.observation_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'person_records', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_person_observation_or_entity_link'
  FROM public.person_records t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE t.review_state = 'verified'
    AND NOT (t.metadata ? 'merged_into_person_record_id'
      OR t.metadata ? 'resolved_into_person_record_id')
    AND (
      EXISTS (
        SELECT 1
        FROM pg_temp.fcm_verified_transfer_stage observation
        JOIN public.observations source_observation
          ON source_observation.id = observation.entity_id
        WHERE observation.entity_table = 'observations'
          AND observation.source_organization_id = t.organization_id
          AND source_observation.organization_id = t.organization_id
          AND source_observation.person_record_id = t.id
      )
      OR EXISTS (
        SELECT 1
        FROM pg_temp.fcm_verified_transfer_stage link_stage
        JOIN public.entity_links link ON link.id = link_stage.entity_id
        WHERE link_stage.entity_table = 'entity_links'
          AND link_stage.source_organization_id = t.organization_id
          AND link.organization_id = t.organization_id
          AND link.evidence->>'person_record_id' = t.id::text
      )
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'observation_person_mentions', t.id, t.organization_id, v_rm,
    t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_person_and_observation_mention'
  FROM public.observation_person_mentions t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage observation
    ON observation.entity_table = 'observations'
    AND observation.entity_id = t.observation_id
  JOIN pg_temp.fcm_verified_transfer_stage person
    ON person.entity_table = 'person_records'
    AND person.entity_id = t.person_record_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  CREATE TEMP TABLE fcm_vehicle_candidates (
    vehicle_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.fcm_vehicle_candidates (vehicle_id)
  SELECT t.vehicle_id
  FROM public.vehicle_observations t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_user_id
  WHERE t.vehicle_id IS NOT NULL;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'vehicles', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_vehicle_observation_or_person_link'
  FROM public.vehicles t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_vehicle_candidates c ON c.vehicle_id = t.id
  WHERE NOT EXISTS (
      SELECT 1
      FROM public.vehicles existing
      WHERE existing.organization_id = v_rm
        AND upper(trim(existing.plate)) = upper(trim(t.plate))
        AND existing.id <> t.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.vehicles other_source
      JOIN pg_temp.fcm_source_organizations other_org
        ON other_org.organization_id = other_source.organization_id
      WHERE other_source.id <> t.id
        AND upper(trim(other_source.plate)) = upper(trim(t.plate))
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'vehicle_observations', t.id, t.organization_id, v_rm, t.officer_user_id, t.observed_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_vehicle_observation'
  FROM public.vehicle_observations t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.officer_user_id
  WHERE t.vehicle_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_temp.fcm_verified_transfer_stage v
      WHERE v.entity_table = 'vehicles'
        AND v.entity_id = t.vehicle_id
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'person_record_aliases', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_person_record_alias'
  FROM public.person_record_aliases t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage p
    ON p.entity_table = 'person_records' AND p.entity_id = t.person_record_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'canonical_person_links', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_person_record_link'
  FROM public.canonical_person_links t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage p
    ON p.entity_table = 'person_records'
    AND p.entity_id = t.source_id
  WHERE t.source_table = 'person_records';

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'person_permits', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_client_permit_actor'
  FROM public.person_permits t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_client_organizations c ON c.organization_id = t.client_organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'person_permit_vehicles', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_client_permit_vehicle'
  FROM public.person_permit_vehicles t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage p
    ON p.entity_table = 'person_permits' AND p.entity_id = t.permit_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'dispatch_jobs', t.id, t.organization_id, v_rm, t.assigned_officer_id, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    CASE WHEN t.service_agreement_id IN (SELECT agreement_id FROM pg_temp.fcm_verified_agreements)
      THEN 'retained_real_service_agreement'
      WHEN t.investigation_id IS NOT NULL THEN 'verified_investigation'
      ELSE 'verified_assigned_officer'
    END
  FROM public.dispatch_jobs t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE t.service_agreement_id IN (SELECT agreement_id FROM pg_temp.fcm_verified_agreements)
    OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_actors a
      WHERE a.actor_id = t.assigned_officer_id
    )
    OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_transfer_stage i
      WHERE i.entity_table = 'investigations' AND i.entity_id = t.investigation_id
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'sla_clocks', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_service_agreement_or_dispatch_job'
  FROM public.sla_clocks t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE t.service_agreement_id IN (SELECT agreement_id FROM pg_temp.fcm_verified_agreements)
    OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_transfer_stage j
      WHERE j.entity_table = 'dispatch_jobs' AND j.entity_id = t.dispatch_job_id
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'monthly_report_packs', t.id, t.organization_id, v_rm, t.generated_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'retained_real_service_agreement'
  FROM public.monthly_report_packs t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE t.service_agreement_id IN (SELECT agreement_id FROM pg_temp.fcm_verified_agreements)
    AND t.status <> 'sent';

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'dispatch_resources', t.id, t.organization_id, v_rm, t.assigned_officer_id, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_dispatch_job_resource'
  FROM public.dispatch_resources t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  WHERE EXISTS (
    SELECT 1
    FROM pg_temp.fcm_verified_transfer_stage j
    JOIN public.dispatch_jobs job ON job.id = j.entity_id
    WHERE j.entity_table = 'dispatch_jobs'
      AND job.dispatch_resource_id = t.id
  );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'dispatch_job_protected_parties', t.id, t.organization_id, v_rm, t.created_by, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_dispatch_job_and_actor'
  FROM public.dispatch_job_protected_parties t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage j
    ON j.entity_table = 'dispatch_jobs' AND j.entity_id = t.dispatch_job_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.created_by;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'evidence_summary_approvals', t.id, t.organization_id, v_rm,
    coalesce(t.approved_by, t.requested_by), t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_evidence_approval_actor'
  FROM public.evidence_summary_approvals t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage e
    ON e.entity_table = 'evidence_items' AND e.entity_id = t.evidence_id
  WHERE EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_actors a WHERE a.actor_id = t.requested_by
    )
    OR EXISTS (
      SELECT 1 FROM pg_temp.fcm_verified_actors a WHERE a.actor_id = t.approved_by
    );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'vehicle_profile_photos', t.canonical_vehicle_id, t.organization_id, v_rm, t.uploaded_by, t.updated_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_vehicle_photo_and_observation'
  FROM public.vehicle_profile_photos t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_actors a ON a.actor_id = t.uploaded_by
  WHERE EXISTS (
    SELECT 1
    FROM public.parking_chalk_records c
    JOIN pg_temp.fcm_source_organizations source_org
      ON source_org.organization_id = c.organization_id
    JOIN pg_temp.fcm_verified_actors officer
      ON officer.actor_id = c.officer_id
    WHERE c.canonical_vehicle_id = t.canonical_vehicle_id
  );

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'biosecurity_assessment_evidence', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_assessment_and_evidence'
  FROM public.biosecurity_assessment_evidence t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage assessment
    ON assessment.entity_table = 'biosecurity_assessments'
    AND assessment.entity_id = t.biosecurity_assessment_id
  JOIN pg_temp.fcm_verified_transfer_stage evidence
    ON evidence.entity_table = 'evidence_items'
    AND evidence.entity_id = t.evidence_item_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'noise_assessment_evidence', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_assessment_and_evidence'
  FROM public.noise_assessment_evidence t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage assessment
    ON assessment.entity_table = 'noise_assessments'
    AND assessment.entity_id = t.noise_assessment_id
  JOIN pg_temp.fcm_verified_transfer_stage evidence
    ON evidence.entity_table = 'evidence_items'
    AND evidence.entity_id = t.evidence_item_id;

  INSERT INTO pg_temp.fcm_verified_transfer_stage
  SELECT 'smoke_assessment_evidence', t.id, t.organization_id, v_rm, NULL, t.created_at,
    encode(extensions.digest(convert_to((to_jsonb(t) - 'organization_id' - 'updated_at')::text, 'UTF8'), 'sha256'), 'hex'),
    'verified_assessment_and_evidence'
  FROM public.smoke_assessment_evidence t
  JOIN pg_temp.fcm_source_organizations s ON s.organization_id = t.organization_id
  JOIN pg_temp.fcm_verified_transfer_stage assessment
    ON assessment.entity_table = 'smoke_assessments'
    AND assessment.entity_id = t.smoke_assessment_id
  JOIN pg_temp.fcm_verified_transfer_stage evidence
    ON evidence.entity_table = 'evidence_items'
    AND evidence.entity_id = t.evidence_item_id;

  INSERT INTO private.org_consolidation_transfers (
    migration_version, entity_table, entity_id, source_organization_id,
    destination_organization_id, source_actor_id, source_recorded_at,
    source_row_sha256, transfer_basis, recorded_by
  )
  SELECT
    '20261102140000',
    s.entity_table,
    s.entity_id,
    s.source_organization_id,
    s.destination_organization_id,
    s.source_actor_id,
    s.source_recorded_at,
    s.source_row_sha256,
    s.transfer_basis,
    v_actor
  FROM pg_temp.fcm_verified_transfer_stage s;

  FOR v_table IN
    SELECT DISTINCT entity_table
    FROM pg_temp.fcm_verified_transfer_stage
    ORDER BY entity_table
  LOOP
    SELECT count(*) INTO v_expected
    FROM pg_temp.fcm_verified_transfer_stage
    WHERE entity_table = v_table;

    IF v_table = 'vehicle_profile_photos' THEN
      UPDATE public.vehicle_profile_photos target
      SET organization_id = stage.destination_organization_id
      FROM pg_temp.fcm_verified_transfer_stage stage
      WHERE stage.entity_table = v_table
        AND target.canonical_vehicle_id = stage.entity_id
        AND target.organization_id = stage.source_organization_id;
    ELSE
      EXECUTE format(
        'UPDATE public.%I target
         SET organization_id = stage.destination_organization_id
         FROM pg_temp.fcm_verified_transfer_stage stage
         WHERE stage.entity_table = $1
           AND target.id = stage.entity_id
           AND target.organization_id = stage.source_organization_id',
        v_table
      ) USING v_table;
    END IF;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_expected THEN
      RAISE EXCEPTION 'Transfer row count mismatch for %: expected %, updated %',
        v_table, v_expected, v_updated;
    END IF;

    IF v_table = 'vehicle_profile_photos' THEN
      SELECT count(*) INTO v_hash_mismatches
      FROM public.vehicle_profile_photos target
      JOIN pg_temp.fcm_verified_transfer_stage stage
        ON stage.entity_table = v_table
        AND stage.entity_id = target.canonical_vehicle_id
      WHERE target.organization_id IS DISTINCT FROM stage.destination_organization_id
        OR encode(extensions.digest(
          convert_to((to_jsonb(target) - 'organization_id' - 'updated_at')::text, 'UTF8'),
          'sha256'
        ), 'hex') IS DISTINCT FROM stage.source_row_sha256;
    ELSE
      v_sql := format(
        'SELECT count(*)
         FROM public.%I target
         JOIN pg_temp.fcm_verified_transfer_stage stage
           ON stage.entity_table = $1
          AND stage.entity_id = target.id
         WHERE target.organization_id IS DISTINCT FROM stage.destination_organization_id
            OR encode(extensions.digest(
                 convert_to((to_jsonb(target) - ''organization_id'' - ''updated_at'')::text, ''UTF8''),
                 ''sha256''
               ), ''hex'') IS DISTINCT FROM stage.source_row_sha256',
        v_table
      );
      EXECUTE v_sql INTO v_hash_mismatches USING v_table;
    END IF;

    IF v_hash_mismatches <> 0 THEN
      RAISE EXCEPTION 'Post-transfer integrity verification failed for % rows in %',
        v_hash_mismatches, v_table;
    END IF;
  END LOOP;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  )
  VALUES (
    v_rm,
    v_actor,
    'single_provider_operational_custody_consolidation',
    'private.org_consolidation_transfers',
    v_rm,
    jsonb_build_object(
      'migration_version', '20261102140000',
      'transfer_count', (
        SELECT count(*) FROM private.org_consolidation_transfers
        WHERE migration_version = '20261102140000'
      ),
      'client_organization_count', (SELECT count(*) FROM pg_temp.fcm_client_organizations),
      'archived_organization_count', (SELECT count(*) FROM pg_temp.fcm_archived_organizations),
      'source_organization_count', (SELECT count(*) FROM pg_temp.fcm_source_organizations),
      'manual_review_required_person_records_retained', (
        SELECT count(*)
        FROM public.person_records p
        JOIN pg_temp.fcm_source_organizations source_org
          ON source_org.organization_id = p.organization_id
        WHERE p.review_state = 'manual_review_required'
      ),
      'unwired_legacy_person_interactions_retained', (
        SELECT count(*)
        FROM public.person_interactions p
        JOIN pg_temp.fcm_source_organizations source_org
          ON source_org.organization_id = p.organization_id
      ),
      'unwired_legacy_person_vehicle_links_retained', (
        SELECT count(*)
        FROM public.person_vehicle_links p
        JOIN pg_temp.fcm_source_organizations source_org
          ON source_org.organization_id = p.organization_id
      ),
      'excluded', jsonb_build_array(
        'ambiguous records without a verified actor or retained real agreement',
        'person records without verified review and a linked verified operation',
        'unwired legacy person_interactions and person_vehicle_links',
        'client-owned locations, sites and zones',
        'provider-private finance, commercial, HR and payroll records',
        'biometric templates and person-class CCTV observations',
        'global canonical person and vehicle registries'
      )
    )
  );
END;
$migration$;

CREATE OR REPLACE FUNCTION private.rm_tenancy_tree_contains(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH RECURSIVE rm_tree(id) AS (
    SELECT t.service_provider_organization_id
    FROM private.platform_tenancy t
    WHERE t.singleton
    UNION
    SELECT child.id
    FROM public.organizations child
    JOIN rm_tree parent ON child.parent_organization_id = parent.id
  )
  SELECT EXISTS (
    SELECT 1 FROM rm_tree WHERE id = p_organization_id
  );
$function$;
REVOKE ALL ON FUNCTION private.rm_tenancy_tree_contains(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.rm_tenancy_tree_contains(uuid) TO postgres;

CREATE OR REPLACE FUNCTION private.enforce_single_provider_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_rm uuid;
  v_owner uuid;
BEGIN
  SELECT service_provider_organization_id, platform_owner_organization_id
  INTO v_rm, v_owner
  FROM private.platform_tenancy
  WHERE singleton;

  IF v_rm IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Single-provider tenancy is not configured';
  END IF;

  IF NEW.organization_type = 'owner' AND NEW.id <> v_owner THEN
    RAISE EXCEPTION 'Iron Eagle is the only platform owner';
  END IF;
  IF NEW.organization_type = 'service_provider' AND NEW.id <> v_rm THEN
    RAISE EXCEPTION 'R&M is the only service provider';
  END IF;
  IF NEW.id = v_owner AND NEW.organization_type <> 'owner' THEN
    RAISE EXCEPTION 'Iron Eagle must remain the platform owner';
  END IF;
  IF NEW.id = v_rm AND NEW.organization_type <> 'service_provider' THEN
    RAISE EXCEPTION 'R&M must remain the single service provider';
  END IF;

  IF TG_OP = 'INSERT'
    AND NEW.id NOT IN (v_rm, v_owner)
    AND NOT private.rm_tenancy_tree_contains(NEW.parent_organization_id) THEN
    RAISE EXCEPTION 'New organisations must be placed under the R&M tenancy';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.active
    AND NEW.id NOT IN (v_rm, v_owner)
    AND NOT private.rm_tenancy_tree_contains(NEW.parent_organization_id) THEN
    RAISE EXCEPTION 'Active organisations must be placed under the R&M tenancy';
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.enforce_single_provider_organization() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.enforce_single_provider_organization() TO postgres;

CREATE TRIGGER enforce_single_provider_organization
BEFORE INSERT OR UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION private.enforce_single_provider_organization();

CREATE OR REPLACE FUNCTION private.enforce_single_provider_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_rm uuid;
  v_owner uuid;
  v_relationship_changed boolean := TG_OP = 'INSERT';
BEGIN
  SELECT service_provider_organization_id, platform_owner_organization_id
  INTO v_rm, v_owner
  FROM private.platform_tenancy
  WHERE singleton;

  IF v_rm IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Single-provider tenancy is not configured';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_relationship_changed :=
      OLD.agreement_type IS DISTINCT FROM NEW.agreement_type
      OR OLD.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
      OR OLD.client_organization_id IS DISTINCT FROM NEW.client_organization_id;
  END IF;

  IF v_relationship_changed THEN
    IF NEW.agreement_type = 'financial' THEN
      IF NEW.provider_organization_id <> v_owner
        OR NEW.client_organization_id <> v_rm THEN
        RAISE EXCEPTION 'Only Iron Eagle to R&M platform billing agreements may be created or reassigned';
      END IF;
    ELSIF NEW.agreement_type = 'operational' THEN
      IF NEW.provider_organization_id = NEW.client_organization_id
        OR NOT private.rm_tenancy_tree_contains(NEW.provider_organization_id)
        OR NOT private.rm_tenancy_tree_contains(NEW.client_organization_id)
        OR NOT EXISTS (
          SELECT 1
          FROM public.organizations provider
          WHERE provider.id = NEW.provider_organization_id
            AND provider.organization_type IN ('service_provider', 'branch', 'contractor')
        )
        OR EXISTS (
          SELECT 1
          FROM public.organizations client
          WHERE client.id = NEW.client_organization_id
            AND client.organization_type = 'owner'
        )
        OR EXISTS (
          SELECT 1
          FROM private.org_consolidation_transfers archived
          WHERE archived.migration_version = '20261102140000'
            AND archived.entity_table = 'organizations'
            AND archived.entity_id = NEW.client_organization_id
            AND archived.transfer_basis = 'legacy_provider_or_test_organization_archived'
        ) THEN
        RAISE EXCEPTION 'Operational agreements must connect an R&M-tree provider to a non-archived R&M-tree client';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported service agreement type';
    END IF;
  END IF;

  IF NEW.ends_on IS NULL OR NEW.ends_on >= current_date THEN
    IF NEW.agreement_type = 'operational'
      AND (
        NOT private.rm_tenancy_tree_contains(NEW.provider_organization_id)
        OR NOT private.rm_tenancy_tree_contains(NEW.client_organization_id)
        OR EXISTS (
          SELECT 1
          FROM private.org_consolidation_transfers archived
          WHERE archived.migration_version = '20261102140000'
            AND archived.entity_table = 'organizations'
            AND archived.entity_id = NEW.client_organization_id
            AND archived.transfer_basis = 'legacy_provider_or_test_organization_archived'
        )
      ) THEN
      RAISE EXCEPTION 'Active operational agreements must remain inside the R&M tenancy';
    END IF;

    IF NEW.agreement_type = 'financial'
      AND (NEW.provider_organization_id <> v_owner OR NEW.client_organization_id <> v_rm) THEN
      RAISE EXCEPTION 'Active platform billing must remain between Iron Eagle and R&M';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.enforce_single_provider_agreement() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.enforce_single_provider_agreement() TO postgres;

CREATE TRIGGER enforce_single_provider_agreement
BEFORE INSERT OR UPDATE ON public.service_agreements
FOR EACH ROW EXECUTE FUNCTION private.enforce_single_provider_agreement();

CREATE OR REPLACE FUNCTION public.field_place_provider_allowed(p_provider_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.rm_tenancy_tree_contains(p_provider_id)
    AND EXISTS (
      SELECT 1
      FROM public.organizations provider
      WHERE provider.id = p_provider_id
        AND provider.active
        AND provider.organization_type IN ('service_provider', 'branch', 'contractor')
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles u
      WHERE u.id = auth.uid()
        AND u.deactivated_at IS NULL
        AND u.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master')
        AND (
          u.organization_id = p_provider_id
          OR (
            u.role IN ('admin_officer', 'admin', 'master', 'grand_master')
            AND public.is_admin_for_org(p_provider_id)
          )
          OR EXISTS (
            SELECT 1
            FROM public.staff_branch_authorisations b
            WHERE b.user_id = u.id
              AND b.branch_org_id = p_provider_id
              AND b.status = 'active'
              AND (b.starts_on IS NULL OR b.starts_on <= current_date)
              AND (b.ends_on IS NULL OR b.ends_on >= current_date)
          )
        )
    );
$function$;
REVOKE ALL ON FUNCTION public.field_place_provider_allowed(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.field_place_provider_allowed(uuid) TO postgres;

DO $migration$
DECLARE
  v_definition text;
  v_anchor text := 'VALUES (trim(p_name), ''client'', NULL, true, ''active'',';
  v_replacement text := 'VALUES (trim(p_name), ''client'', p_provider_id, true, ''active'',';
  v_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.save_service_client(uuid,uuid,uuid,timestamptz,text,text,text,text,boolean)'::regprocedure
  ) INTO v_definition;

  v_count := (
    length(v_definition) - length(replace(v_definition, v_anchor, ''))
  ) / length(v_anchor);

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'save_service_client insert anchor changed: expected exactly one, found %', v_count;
  END IF;

  EXECUTE replace(v_definition, v_anchor, v_replacement);
END;
$migration$;

REVOKE ALL ON FUNCTION public.platform_provision_subscriber(uuid, uuid, text, text[], date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_provision_subscriber(uuid, uuid, text, text[], date)
  TO postgres;
REVOKE ALL ON FUNCTION public.platform_provision_subscriber_internal(uuid, uuid, uuid, text, text[], date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_provision_subscriber_internal(uuid, uuid, uuid, text, text[], date)
  TO postgres;