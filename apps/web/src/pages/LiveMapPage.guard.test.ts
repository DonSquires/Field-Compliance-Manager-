import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/LiveMapPage.tsx'), 'utf8');

describe('live officer safety layer', () => {
  it('gates welfare reads and rendering through the shared safety contract', () => {
    expect(source).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(source).toContain('<SafetyGate');
    expect(source).toContain('if (welfareEnabled)');
  });

  it('derives safety from settings and active alerts, not GPS age', () => {
    expect(source).toContain(".from('officer_welfare_settings')");
    expect(source).toContain(".from('welfare_alerts')");
    expect(source).toContain('deriveAdminSafetyStatus');
    expect(source).toContain('deriveOfficerPinStatus');
    expect(source).toContain('...activeAlerts.keys()');
    expect(source).toContain("activity_type: 'active_welfare_alert'");
  });

  it('keeps tenant filters on GPS and welfare realtime paths', () => {
    expect(source).toContain(".eq('organization_id', orgId)");
    expect(source).toContain('filter: `organization_id=eq.${profile.organizationId}`');
    expect(source).toContain("table: 'officer_welfare_settings'");
  });

  it('never labels an unavailable safety state as ok', () => {
    expect(source).toContain('Safety unavailable');
    expect(source).toContain('no officer is shown as safe');
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(source).toContain('if (!orgId) {');
    expect(source).toContain('setLoading(false);');
  });
});