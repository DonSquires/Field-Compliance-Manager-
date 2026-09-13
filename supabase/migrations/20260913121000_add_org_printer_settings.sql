-- Per-organization printer preference for module notice printing. Two real
-- connection paths: 'bluetooth_escpos' (Web Bluetooth -> raw ESC/POS bytes,
-- narrow thermal printers) and 'browser_print' (the OS print dialog, for
-- WiFi/USB/AirPrint receipt printers registered as a normal system printer --
-- browsers cannot open a raw TCP socket to a WiFi printer directly, so this
-- is the real working path for network printers, not a raw-socket bridge).
CREATE TABLE IF NOT EXISTS public.org_printer_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  paper_width text NOT NULL DEFAULT '58mm' CHECK (paper_width IN ('58mm', '80mm', 'a4')),
  connection_type text NOT NULL DEFAULT 'browser_print' CHECK (connection_type IN ('bluetooth_escpos', 'browser_print')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.user_profiles(id)
);

COMMENT ON TABLE public.org_printer_settings IS
  'One row per organization: preferred paper width and connection path for printing module notices/infringements.';

ALTER TABLE public.org_printer_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_printer_settings_select ON public.org_printer_settings;
CREATE POLICY org_printer_settings_select ON public.org_printer_settings
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.org_printer_settings FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.org_printer_settings TO authenticated;
GRANT ALL ON TABLE public.org_printer_settings TO service_role;

CREATE OR REPLACE FUNCTION public.manage_org_printer_settings(
  p_organization_id uuid,
  p_paper_width text,
  p_connection_type text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.org_printer_settings%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organization administrator required';
  END IF;
  IF p_paper_width NOT IN ('58mm', '80mm', 'a4') THEN RAISE EXCEPTION 'Invalid paper_width'; END IF;
  IF p_connection_type NOT IN ('bluetooth_escpos', 'browser_print') THEN RAISE EXCEPTION 'Invalid connection_type'; END IF;

  INSERT INTO public.org_printer_settings (organization_id, paper_width, connection_type, updated_by)
  VALUES (p_organization_id, p_paper_width, p_connection_type, v_actor)
  ON CONFLICT (organization_id) DO UPDATE SET
    paper_width = excluded.paper_width,
    connection_type = excluded.connection_type,
    updated_at = now(),
    updated_by = excluded.updated_by
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'organization_id', v_row.organization_id,
    'paper_width', v_row.paper_width,
    'connection_type', v_row.connection_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manage_org_printer_settings(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_org_printer_settings(uuid,text,text) TO authenticated, service_role;
