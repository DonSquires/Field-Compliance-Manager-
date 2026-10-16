import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(resolve(process.cwd(), 'src/components/NoticePrintActions.tsx'), 'utf8');
const hookSource = readFileSync(resolve(process.cwd(), 'src/hooks/useOrganizationPrinterSettings.ts'), 'utf8');
const parkingSource = readFileSync(resolve(process.cwd(), 'src/pages/ParkingOversightPage.tsx'), 'utf8');
const breachSource = readFileSync(resolve(process.cwd(), 'src/pages/BreachReviewPage.tsx'), 'utf8');

describe('organization printer defaults', () => {
  it('loads the selected organization setting and surfaces load failure instead of hiding it', () => {
    expect(hookSource).toContain(".from('org_printer_settings')");
    expect(hookSource).toContain(".eq('organization_id', organizationId)");
    expect(hookSource).toContain('Printer defaults could not be loaded.');
    expect(componentSource).toContain('{settingsError &&');
    expect(componentSource).toContain("settings.connectionType === 'browser_print' ? 'Print via browser (default)'");
    expect(componentSource).toContain("settings.connectionType === 'bluetooth_escpos' ? 'Print via Bluetooth (default)'");
  });

  it('uses A4 only through browser printing and keeps ESC/POS thermal widths bounded', () => {
    expect(componentSource).toContain("const thermalPaperWidth: ReceiptPaperWidth = paperWidth === '58mm' ? '58mm' : '80mm'");
    expect(componentSource).toContain("if (paperWidth === 'a4')");
    expect(componentSource).toContain("const pageSize = paperWidth === 'a4' ? 'A4'");
    expect(componentSource).toContain('disabled={busy || paperWidth ===');
  });

  it('scopes both operational print surfaces to the selected operating organization', () => {
    for (const source of [parkingSource, breachSource]) {
      expect(source).toContain('const { profile, operatingOrganizationId } = useAuth();');
      expect(source).toContain('const orgId = operatingOrganizationId ?? profile?.organizationId;');
      expect(source).toContain('organizationId={operatingOrganizationId ?? profile?.organizationId ?? null}');
    }
  });
});
