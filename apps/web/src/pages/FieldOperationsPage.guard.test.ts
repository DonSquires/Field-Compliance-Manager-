import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.css'), 'utf8');

describe('field operations command surface', () => {
  it('invalidates previous-scope counts and validates agreement scope', () => {
    expect(page).toContain('loadedOrganizationId === organizationId');
    expect(page).toContain('const request = ++requestGeneration.current');
    expect(page).toContain('if (request !== requestGeneration.current) return;');
    expect(page).toContain('if (request === requestGeneration.current) setLoading(false)');
    expect(page).toContain('useLayoutEffect(() =>');
    expect(page).toContain(".eq('organization_id', organizationId).in('zone_id', activeZoneIds)");
  });

  it('replaces the exposed placeholder with the operational landing page', () => {
    expect(shell).toContain("case 'landing':");
    expect(shell).toContain('<FieldOperationsPage onNavigate={navigateToFieldOps} />');
    expect(shell).not.toContain('return <ComingSoonPage title="Field Operations" />');
  });

  it('provides interactive routes for each implemented operational workflow', () => {
    for (const area of ['dispatch', 'patrol', 'live-map', 'officer-activity', 'welfare-alerts', 'breach-review', 'vehicle-search', 'person-search', 'field-reports']) {
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
    expect(page).not.toContain('nzscv_monitor');
    expect(page).toContain('workflow.roles.includes(role)');
    expect(page).toContain('workflow.moduleKeys.some');
    expect(page).toContain("label: 'Patrol evidence'");
    expect(page).toContain("moduleKeys: ['patrol', 'static_guarding']");
    expect(page).not.toContain('Manage routes, checkpoints, visits, and exceptions');
  });

  it('uses role-specific language for operational administrators', () => {
    expect(page).toContain("admin_officer: { eyebrow: 'Operations control', title: 'Operations workspace'");
    expect(page).toContain("const dispatchEnabled = isModuleEnabled('dispatch')");
    expect(page).toContain('const dispatchAvailable = dispatchEnabled;');
    expect(page).not.toContain('useActiveModuleContext');
  });

  it('uses independent live count queries with explicit unavailable state', () => {
    for (const table of ['shifts', 'dispatch_jobs', 'welfare_alerts', 'officer_field_reports']) {
      expect(page).toContain(`from('${table}')`);
    }
    expect(page).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(page).toContain("const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(page).toContain('workflow.moduleKeys.some');
    expect(page).toContain('safetyRelevant: workflow.safetyRelevant');
    expect(page).toContain("import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus'");
    expect(page).toContain(".in('status', ACTIVE_DISPATCH_JOB_STATUSES)");
    expect(page).toContain('[dispatchAvailable, organizationId, loadedOrganizationId, selectedAgreementZones, welfareEnabled]');
    expect(page).toContain('Some operational counts are unavailable');
  });

  it('keeps workload counts beside their workspace actions rather than repeating a second metrics dashboard', () => {
    expect(page).not.toContain('className="field-ops-metrics"');
    expect(page).toContain("metric: 'activeDispatch'");
    expect(page).toContain("metric: 'onDuty'");
    expect(page).toContain("metric: 'welfareAlerts'");
    expect(page).toContain("metric: 'reportFollowUp'");
    expect(page).toContain('field-ops-workflow-count');
    expect(page).toContain('Current workload:');
  });

  it('keeps workflow panes contained and welfare counts on their actual organization spine', () => {
    expect(page).toContain('aria-label="Workflow panes"');
    expect(page).toContain('Find a workflow');
    const welfareQueries = page.split('\n').filter((line) => line.includes("from('welfare_alerts')"));
    expect(welfareQueries).toHaveLength(1);
    expect(welfareQueries[0]).not.toContain("in('zone_id'");
    expect(welfareQueries[0]).toContain("eq('organization_id', organizationId)");
  });

  it('retains full-bleed two-pane grid and independent scrolling rather than stacked cards', () => {
    expect(css).toContain('height: 100%');
    expect(css).toContain('min-height: 0');
    expect(css).toContain('overflow: hidden');
    expect(css).toContain('grid-template-columns: minmax(0,1fr) minmax(0,1fr)');
    expect(css).toMatch(/\.field-ops-workflow-grid\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toContain('border-radius: 0');
    expect(css).not.toContain('max-width: 1320px');
    expect(page).toContain('data-active-group={activeGroup}');
  });
});