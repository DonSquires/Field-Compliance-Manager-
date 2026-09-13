-- House-level module assignment. Sites and Zones remain sibling geofence
-- facets; this table records which standalone modules are authorized at the
-- parent Location/House under which active service agreement.
CREATE TABLE IF NOT EXISTS public.location_module_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  rule_set_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id),
  CONSTRAINT location_module_assignments_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT location_module_assignments_unique UNIQUE (location_id, module_key, service_agreement_id)
);

CREATE INDEX IF NOT EXISTS idx_location_module_assignments_lookup
  ON public.location_module_assignments (location_id, module_key, enabled, effective_from DESC);

ALTER TABLE public.location_module_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_module_assignments_select ON public.location_module_assignments;
CREATE POLICY location_module_assignments_select ON public.location_module_assignments
  FOR SELECT TO authenticated
  USING (public.org_access_allowed((SELECT l.organization_id FROM public.locations l WHERE l.id = location_id)));
DROP POLICY IF EXISTS location_module_assignments_insert ON public.location_module_assignments;
CREATE POLICY location_module_assignments_insert ON public.location_module_assignments
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_for_org((SELECT sa.provider_organization_id FROM public.service_agreements sa WHERE sa.id = service_agreement_id)));
DROP POLICY IF EXISTS location_module_assignments_update ON public.location_module_assignments;
CREATE POLICY location_module_assignments_update ON public.location_module_assignments
  FOR UPDATE TO authenticated
  USING (public.is_admin_for_org((SELECT sa.provider_organization_id FROM public.service_agreements sa WHERE sa.id = service_agreement_id)))
  WITH CHECK (public.is_admin_for_org((SELECT sa.provider_organization_id FROM public.service_agreements sa WHERE sa.id = service_agreement_id)));

REVOKE ALL ON TABLE public.location_module_assignments FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.location_module_assignments TO authenticated;
GRANT ALL ON TABLE public.location_module_assignments TO service_role;

-- Existing active contract/module/facet links are authoritative for the initial
-- House assignment. The distinct key makes this safe to re-run.
INSERT INTO public.location_module_assignments (location_id, module_key, service_agreement_id, created_by)
SELECT DISTINCT COALESCE(cs.location_id, z.location_id), sam.module_key, sa.id, NULL::uuid
FROM public.service_agreements sa
JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
LEFT JOIN public.client_sites cs ON cs.id = sal.site_id
LEFT JOIN public.location_zones z ON z.id = sal.zone_id
WHERE sa.invitation_status = 'accepted'
  AND sa.starts_on <= current_date
  AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
  AND COALESCE(cs.location_id, z.location_id) IS NOT NULL
ON CONFLICT (location_id, module_key, service_agreement_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.manage_location_module_assignment(
  p_location_id uuid,
  p_service_agreement_id uuid,
  p_module_key text,
  p_enabled boolean DEFAULT true,
  p_effective_from date DEFAULT current_date,
  p_effective_to date DEFAULT NULL
)
RETURNS public.location_module_assignments
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_assignment public.location_module_assignments%rowtype;
  v_provider uuid;
BEGIN
  SELECT sa.provider_organization_id INTO v_provider
  FROM public.service_agreements sa
  WHERE sa.id = p_service_agreement_id
    AND sa.invitation_status = 'accepted'
    AND sa.starts_on <= coalesce(p_effective_from, current_date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= coalesce(p_effective_from, current_date));
  IF v_provider IS NULL THEN RAISE EXCEPTION 'Accepted active service agreement required'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Provider administrator required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.service_agreement_modules sam
    WHERE sam.service_agreement_id = p_service_agreement_id
      AND sam.module_key = p_module_key
      AND sam.enabled
  ) THEN RAISE EXCEPTION 'Module is not enabled on the service agreement'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id) THEN RAISE EXCEPTION 'Location house not found'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.locations l
    JOIN public.service_agreements sa ON sa.id = p_service_agreement_id
    WHERE l.id = p_location_id AND l.organization_id = sa.client_organization_id
  ) THEN RAISE EXCEPTION 'Location house is outside the service agreement client organization'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.service_agreement_locations sal
    LEFT JOIN public.client_sites cs ON cs.id = sal.site_id
    LEFT JOIN public.location_zones z ON z.id = sal.zone_id
    WHERE sal.service_agreement_id = p_service_agreement_id
      AND sal.status = 'active'
      AND (cs.location_id = p_location_id OR z.location_id = p_location_id)
  ) THEN RAISE EXCEPTION 'Service agreement has no active Site or Zone facet under this Location house'; END IF;

  INSERT INTO public.location_module_assignments (
    location_id, module_key, service_agreement_id, enabled, effective_from, effective_to, updated_at, created_by
  ) VALUES (
    p_location_id, p_module_key, p_service_agreement_id, coalesce(p_enabled, true),
    coalesce(p_effective_from, current_date), p_effective_to, now(), v_actor
  )
  ON CONFLICT (location_id, module_key, service_agreement_id)
  DO UPDATE SET enabled = excluded.enabled, effective_from = excluded.effective_from,
                effective_to = excluded.effective_to, updated_at = now()
  RETURNING * INTO v_assignment;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  SELECT l.organization_id, v_actor, 'location_module_assignment_set', 'location_module_assignments', v_assignment.id,
         jsonb_build_object('location_id', p_location_id, 'module_key', p_module_key, 'service_agreement_id', p_service_agreement_id, 'enabled', v_assignment.enabled)
  FROM public.locations l WHERE l.id = p_location_id;

  RETURN v_assignment;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_location_module_assignment(uuid,uuid,text,boolean,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_location_module_assignment(uuid,uuid,text,boolean,date,date) TO authenticated, service_role;
