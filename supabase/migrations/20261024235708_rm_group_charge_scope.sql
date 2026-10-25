-- R&M group charge-code scope and Mainland parentage.
--
-- Owner ruling 2026-10-25 (recorded choices, superseding the scope and
-- parentage statements in 20261024233829_rm_charge_code_catalog.sql):
--   * scope = rm_group: the charge catalog applies to R&M, Mainland Pest
--     Control, and R&M's client organisations, not only the two operators;
--   * mainland_parent = true: Mainland Pest Control sits under R&M in the
--     organisation tree. R&M already roots its client organisations there, so
--     R&M masters and admins reach Mainland by tree descent; Mainland users
--     gain no upward access.
--
-- R&M owns the catalog. Group members hold synchronised copies marked with
-- catalog_source_organization_id. The group is the R&M tree plus the client
-- side of every active agreement whose provider is in that tree. Membership
-- added later (a new child or a new agreement) receives the catalog through
-- triggers. Ending an agreement removes nothing.

UPDATE public.organizations
SET parent_organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,
    external_refs = (external_refs - 'corporate_group') || jsonb_build_object('corporate_group', jsonb_build_object(
      'parent_organization_id', 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',
      'relationship', 'subsidiary',
      'grants_access', true,
      'recorded_from', 'owner ruling 2026-10-25 (mainland_parent=true)',
      'canon', 'docs/canon/ORG_SERVICE_MODEL.md ruling 2026-10-25: Mainland Pest Control under R&M')),
    updated_at = now()
WHERE id = '1ccdd3fb-0b0a-478d-8441-6f14a85172aa'::uuid
  AND parent_organization_id IS NULL;

CREATE OR REPLACE FUNCTION public.sync_group_charge_catalog(p_source uuid, p_target uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows integer;
BEGIN
  IF p_source IS NULL OR p_target IS NULL OR p_source = p_target THEN RETURN 0; END IF;
  INSERT INTO public.reference_codes(
    organization_id, code_type, code, name, description, is_active, sort_order, external_refs
  )
  SELECT p_target, source.code_type, source.code, source.name, source.description, source.is_active, source.sort_order,
         source.external_refs || jsonb_build_object('catalog_source_organization_id',
           coalesce(source.external_refs->>'catalog_source_organization_id', p_source::text))
  FROM public.reference_codes source
  WHERE source.organization_id = p_source
    AND source.code_type IN ('charge_source', 'charge_subject', 'charge_issue', 'charge_code')
    AND source.external_refs->>'scheme' = 'rm_group_charge_code'
    AND EXISTS (SELECT 1 FROM public.organizations target WHERE target.id = p_target)
  ON CONFLICT (organization_id, code_type, code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    external_refs = EXCLUDED.external_refs,
    updated_at = now()
  WHERE reference_codes.external_refs->>'scheme' = 'rm_group_charge_code';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;
REVOKE ALL ON FUNCTION public.sync_group_charge_catalog(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.charge_catalog_group_members(p_root uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH tree AS (
    SELECT unnest(public.get_descendant_organizations(p_root)) AS id
  )
  SELECT id FROM tree
  UNION
  SELECT agreement.client_organization_id
  FROM public.service_agreements agreement
  JOIN tree ON tree.id = agreement.provider_organization_id
  WHERE agreement.client_organization_id IS NOT NULL
    AND agreement.agreement_type = 'operational'
    AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date);
$function$;
REVOKE ALL ON FUNCTION public.charge_catalog_group_members(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_group_charge_catalog(p_root uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_member uuid; v_total integer := 0;
BEGIN
  FOR v_member IN SELECT member FROM public.charge_catalog_group_members(p_root) member WHERE member <> p_root LOOP
    v_total := v_total + public.sync_group_charge_catalog(p_root, v_member);
  END LOOP;
  RETURN v_total;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_group_charge_catalog(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.propagate_group_charge_catalog_to_child()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.parent_organization_id IS NOT NULL THEN
    PERFORM public.sync_group_charge_catalog(NEW.parent_organization_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.propagate_group_charge_catalog_to_child() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.propagate_group_charge_catalog_to_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.client_organization_id IS NOT NULL
     AND NEW.agreement_type = 'operational'
     AND (NEW.ends_on IS NULL OR NEW.ends_on >= current_date) THEN
    PERFORM public.sync_group_charge_catalog(NEW.provider_organization_id, NEW.client_organization_id);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.propagate_group_charge_catalog_to_client() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_propagate_group_charge_catalog ON public.organizations;
CREATE TRIGGER trg_propagate_group_charge_catalog
  AFTER INSERT OR UPDATE OF parent_organization_id ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.propagate_group_charge_catalog_to_child();

DROP TRIGGER IF EXISTS trg_propagate_group_charge_catalog ON public.service_agreements;
CREATE TRIGGER trg_propagate_group_charge_catalog
  AFTER INSERT OR UPDATE OF provider_organization_id, client_organization_id, ends_on, agreement_type ON public.service_agreements
  FOR EACH ROW EXECUTE FUNCTION public.propagate_group_charge_catalog_to_client();

SELECT public.refresh_group_charge_catalog('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
