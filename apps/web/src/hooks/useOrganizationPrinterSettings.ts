import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type PrinterPaperWidth = '58mm' | '80mm' | 'a4';
export type PrinterConnectionType = 'bluetooth_escpos' | 'browser_print';

export interface OrganizationPrinterSettings {
  paperWidth: PrinterPaperWidth;
  connectionType: PrinterConnectionType;
  configured: boolean;
}

const DEFAULT_SETTINGS: OrganizationPrinterSettings = {
  paperWidth: '58mm',
  connectionType: 'browser_print',
  configured: false,
};

function isPaperWidth(value: string): value is PrinterPaperWidth {
  return value === '58mm' || value === '80mm' || value === 'a4';
}

function isConnectionType(value: string): value is PrinterConnectionType {
  return value === 'bluetooth_escpos' || value === 'browser_print';
}

export function useOrganizationPrinterSettings(organizationId: string | null | undefined) {
  const [settings, setSettings] = useState<OrganizationPrinterSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!organizationId) {
        setSettings(DEFAULT_SETTINGS);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      setSettings(DEFAULT_SETTINGS);

      // ATLAS READS: org_printer_settings
      const { data, error: loadError } = await supabase
        .from('org_printer_settings')
        .select('paper_width, connection_type')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (cancelled) return;

      if (loadError) {
        setSettings(DEFAULT_SETTINGS);
        setError('Printer defaults could not be loaded. This print will use the safe browser and 58 mm defaults.');
      } else if (data && isPaperWidth(data.paper_width) && isConnectionType(data.connection_type)) {
        setSettings({
          paperWidth: data.paper_width,
          connectionType: data.connection_type,
          configured: true,
        });
      } else {
        setSettings(DEFAULT_SETTINGS);
      }
      setLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  return { settings, loading, error };
}
