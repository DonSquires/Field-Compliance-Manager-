ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_org_client_request
  ON public.locations(organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manage_crm_location(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_action text,
  p_name text,
  p_address text DEFAULT NULL,
  p_suburb text DEFAULT NULL,
  p_postcode text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.locations
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_location public.locations%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_address text := nullif(trim(coalesce(p_address, '')), '');
  v_address_key text := nullif(regexp_replace(lower(coalesce(v_address, '')), '[^a-z0-9]+', '', 'g'), '');
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_account(p_organization_id) THEN
    RAISE EXCEPTION 'Active CRM administrator required for this organization';
  END IF;
  IF p_action <> 'create' THEN RAISE EXCEPTION 'Unsupported location action'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF v_name IS NULL OR char_length(v_name) > 200 THEN RAISE EXCEPTION 'Location name is required and must be 200 characters or fewer'; END IF;
  IF v_address IS NOT NULL AND char_length(v_address) > 500 THEN RAISE EXCEPTION 'Location address must be 500 characters or fewer'; END IF;

  SELECT * INTO v_location
  FROM public.locations
  WHERE organization_id = p_organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN RETURN v_location; END IF;

  IF v_address_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.locations
    WHERE organization_id = p_organization_id AND address_match_key = v_address_key
  ) THEN
    RAISE EXCEPTION 'A location with this address already exists for the organization';
  END IF;

  INSERT INTO public.locations(
    organization_id, name, address, address_match_key, suburb, postcode, notes, created_by, client_request_id
  ) VALUES (
    p_organization_id, v_name, v_address, v_address_key,
    nullif(trim(coalesce(p_suburb, '')), ''),
    nullif(trim(coalesce(p_postcode, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''), v_actor, p_client_request_id
  ) RETURNING * INTO v_location;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_provider, v_actor, 'crm_location_created', 'locations', v_location.id,
    jsonb_build_object('account_organization_id', p_organization_id, 'address_match_key', v_address_key)
  );
  RETURN v_location;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON public.locations FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.manage_crm_location(uuid, uuid, text, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_location(uuid, uuid, text, text, text, text, text, text) TO authenticated, service_role;