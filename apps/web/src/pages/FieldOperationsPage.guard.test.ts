import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('field operations command surface', () => {
  it('replaces the exposed placeholder with the operational landing page', () => {
    expect(shell).toContain("case 'landing':");
    expect(shell).toContain('<FieldOperationsPage onNavigate={navigateToFieldOps} />');
    expect(shell).not.toContain('return <ComingSoonPage title="Field Operations" />');
  });

  it('provides interactive routes for each implemented operational workflow', () => {
    for (const area of ['dispatch', 'patrol', 'live-map', 'officer-activity', 'welfare-alerts', 'breach-review', 'vehicle-search', 'field-reports']) {
      expect(page).toContain(`area: '${area}'`);
    }
    expect(page).toContain('onClick={() => onNavigate(area)}');
  });

  it('consolidates CCTV and filters tools by role and module entitlement', () => {
    expect(page).toContain("label: 'CCTV & video'");
    expect(page).not.toContain("label: 'Import camera footage'");
    expect(page).not.toContain("label: 'CCTV job queue & exports'");
    expect(page).not.toContain("label: 'Completed videos'");
    expect(page).toContain("const OPERATIONS_ROLES: AppRole[] = ['grand_master', 'master', 'admin', 'admin_officer']");
    expect(page).toContain("const COMPLIANCE_ROLES: AppRole[] = [...OPERATIONS_ROLES, 'nzscv_monitor']");
    expect(page).toContain('workflow.roles.includes(role)');
    expect(page).toContain('workflow.moduleKeys.some');
  });

  it('uses role-specific language and avoids irrelevant team metric reads for NZSCV monitors', () => {
    expect(page).toContain("admin_officer: { eyebrow: 'Operations control', title: 'Operations workspace'");
    expect(page).toContain("nzscv_monitor: { eyebrow: 'Vehicle compliance', title: 'Vehicle compliance'");
    expect(page).toContain("const showTeamMetrics = role !== 'nzscv_monitor'");
    expect(page).toContain("const dispatchEnabled = isModuleEnabled('dispatch')");
    expect(page).toContain("const dispatchContext = useActiveModuleContext('dispatch')");
    expect(page).toContain('const dispatchAvailable = dispatchEnabled && dispatchContext.enabled');
    expect(page).toContain('!showTeamMetrics ? unavailableForRole');
  });

  it('uses independent live count queries with explicit unavailable state', () => {
    for (const table of ['shifts', 'dispatch_jobs', 'welfare_alerts', 'officer_field_reports']) {
      expect(page).toContain(`from('${table}')`);
    }
    expect(page).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(page).toContain('<SafetyGate');
    expect(page).toContain('Welfare monitoring is unavailable until organisation entitlement is confirmed.');
    expect(page).toContain("import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus'");
    expect(page).toContain(".in('status', ACTIVE_DISPATCH_JOB_STATUSES)");
    expect(page).toContain('[dispatchAvailable, profile?.organizationId, selectedAgreementZones, showTeamMetrics, welfareEnabled]');
    expect(page).toContain('Some operational counts are unavailable');
  });
});