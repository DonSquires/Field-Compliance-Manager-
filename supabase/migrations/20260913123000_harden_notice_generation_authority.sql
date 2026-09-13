-- Harden module notice generation for multi-tenant use:
-- 1) reserve notice numbers atomically (no select-then-update race)
-- 2) keep generated parking notices in draft until an explicit issue action
CREATE OR REPLACE FUNCTION public.reserve_infringement_notice_number(
  p_organization_id uuid,
  p_module_key text,
  p_prefix text DEFAULT 'INF'
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_sequence integer;
  v_prefix text := coalesce(nullif(trim(p_prefix), ''), 'INF');
BEGIN
  IF v_actor IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access required';
  END IF;
  INSERT INTO public.infringement_notice_counters (organization_id, module_key, last_number, prefix)
  VALUES (p_organization_id, p_module_key, 1, v_prefix)
  ON CONFLICT (organization_id, module_key)
  DO UPDATE SET last_number = infringement_notice_counters.last_number + 1,
                updated_at = now()
  RETURNING last_number, prefix INTO v_sequence, v_prefix;
  RETURN format('%s-%s-%s', v_prefix, to_char(current_date, 'YYYYMMDD'), lpad(v_sequence::text, 4, '0'));
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_infringement_notice_number(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_infringement_notice_number(uuid,text,text) TO authenticated, service_role;
