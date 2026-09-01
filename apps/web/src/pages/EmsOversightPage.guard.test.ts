import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const officerSource = readFileSync(resolve(process.cwd(), 'src/pages/OfficerEmsDevicePage.tsx'), 'utf8');
const adminSource = readFileSync(resolve(process.cwd(), 'src/pages/EmsOversightPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');

describe('OfficerEmsDevicePage', () => {
  it('submits device checks through the RPC rather than a direct table write', () => {
    expect(officerSource).toContain("supabase.rpc('submit_ems_device_check'");
    expect(officerSource).not.toContain("from('ems_device_checks').insert(");
  });

  it('replaces the generic field report fallback for the ems officer module', () => {
    expect(shell).toContain("case 'ems':");
    expect(shell).toContain('<OfficerEmsDevicePage />');
    expect(shell).not.toContain("case 'ems':\n        return <OfficerFieldReportPage />;");
  });
});

describe('EmsOversightPage', () => {
  it('responds to alerts through the RPC and requires an outcome before resolving', () => {
    expect(adminSource).toContain("supabase.rpc('respond_to_ems_alert'");
    expect(adminSource).toContain("alert.status === 'acknowledged' && !outcomeInputs[alert.id]");
  });

  it('is wired as a field-ops sub-area reachable from the operations landing grid', () => {
    expect(adminShell).toContain("'ems-alerts'");
    expect(adminShell).toContain("case 'ems-alerts':");
    expect(adminShell).toContain('<EmsOversightPage />');
    expect(fieldOps).toContain("area: 'ems-alerts'");
  });
});
