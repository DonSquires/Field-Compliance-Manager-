import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AdminHubPage.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/AdminHubPage.css'), 'utf8');
const shellCss = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.css'), 'utf8');

describe('Admin Hub operational data contract', () => {
  it('invalidates previous-scope requests and validates agreement scope', () => {
    expect(source).toContain('loadedOrganizationId === organizationId');
    expect(source).toContain('const request = ++requestGeneration.current');
    expect(source).toContain('if (request !== requestGeneration.current) return;');
    expect(source).toContain('if (request === requestGeneration.current) setLoading(false)');
    expect(source).toContain('useLayoutEffect(() =>');
    const activity = readFileSync(resolve(process.cwd(), 'src/pages/LoggedActivityPanel.tsx'), 'utf8');
    expect(activity).toContain('loadedOrganizationId === organizationId');
    expect(activity).toContain('[agreementKey, refreshKey, organizationId, loadedOrganizationId]');
    expect(activity).toContain(".eq('organization_id', organizationId).or(eventPlaces)");
  });

  it('uses schema-backed operational sources and checks response errors', () => {
    for (const table of ['shifts', 'dispatch_jobs', 'welfare_alerts', 'breach_alerts', 'observations', 'officer_field_reports']) {
      expect(source).toContain(`from('${table}')`);
    }
    expect(source).toContain('metricFrom(onDuty)');
    expect(source).toContain('navigate: `dispatch?job=${encodeURIComponent(job.id)}`');
    expect(source).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(source).toContain('admin-hub-welfare-${organizationId}');
    expect(source).toContain('<SafetyGate');
    expect(source).toContain("import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus'");
    expect(source).toContain(".in('status', ACTIVE_DISPATCH_JOB_STATUSES)");
    expect(source).toContain('welfareRows.error');
    expect(source).toContain('dispatchRows.error');
    expect(source).toContain('breachRows.error');
    expect(source).toContain('reportRows.error');
  });

  it('does not present fabricated NOC or latency telemetry', () => {
    expect(source).not.toContain('NocTerminal');
    expect(source).not.toContain('System Telemetry: Operational');
    expect(source).not.toContain('42ms');
    expect(source).not.toContain('ONNX YOLOv8n');
  });

  it('shows unavailable metrics instead of silently coercing failed reads to zero', () => {
    expect(source).toContain("{ value: null, error: response.error.message }");
    expect(source).toContain("unavailable ? 'Unavailable' : metric.value");
    expect(source).toContain('const attentionUnavailable = attentionMetrics.some((value) => value === null);');
    expect(source).toContain('Some operational counts are unavailable.');
  });

  it('does not leave the operations landing page in an indefinite loading state without tenant scope', () => {
    expect(source).toContain('Organisation access could not be confirmed. Operational metrics are unavailable.');
    expect(source).toContain('setQueueWarnings([message]);');
    expect(source).toContain('setLoading(false);');
  });

  it('keeps the queue beside independently scrollable evidence and exceptions without a duplicate shortcut directory', () => {
    expect(source).toContain('className="admin-overview-layout"');
    expect(source).toContain('className="admin-console-right"');
    expect(source).toContain('className="admin-pane-scroll"');
    expect(source).toContain('aria-label="Overview panes"');
    expect(source).toContain('Shift & compliance exceptions');
    expect(source).not.toContain('<h2>Quick actions</h2>');
    expect(source).not.toContain('Command Centre');
    expect(source).not.toContain('ADMIN_COMMAND_CENTRE_GROUPS');
  });

  it('does not offer navigation from an unavailable welfare metric', () => {
    expect(source).toMatch(/renderUnavailable=\{\(message\) => <MetricCard[^>]+label="Welfare alerts"[^>]+tone="red" \/>\}/);
  });

  it('uses canonical high-contrast tokens and hierarchy for dashboard headings', () => {
    expect(css).toContain('--hub-ink: var(--color-accent-silver-light);');
    expect(css).toContain('--hub-heading: var(--color-brand-primary);');
    expect(css).toContain('.adminhub-command .admin-overview-header h1 { margin: 0; color: var(--hub-heading); font-size: 22px; font-weight: 700;');
    expect(css).toContain('.adminhub-command .admin-section-heading h2 { margin: 0; font-size: 18px; font-weight: 600;');
  });

  it('keeps selected queue text readable on its pale highlight and hover state', () => {
    expect(css).toContain('.admin-queue-row.is-next { border-left: 3px solid var(--hub-accent); background: var(--color-state-selected-bg); color: var(--color-state-selected-text); }');
    expect(css).toContain('.admin-queue-row.is-next strong { color: var(--color-state-selected-text); }');
    expect(css).toContain('.admin-queue-row.is-next > div > span,\n.admin-shell[data-theme] .adminhub-command .admin-queue-row.is-next time { color: var(--color-state-selected-text); }');
    expect(css).toContain('.admin-queue-row.is-next:hover strong { color: var(--color-state-selected-text); }');
    expect(css).toContain('.admin-queue-row.is-next:hover > div > span,\n.admin-shell[data-theme] .adminhub-command .admin-queue-row.is-next:hover time { color: var(--color-state-selected-text); }');
  });

  it('queries welfare organization-wide because welfare alerts have no zone column', () => {
    const welfareQueries = source.split('\n').filter((line) => line.includes("from('welfare_alerts')"));
    expect(welfareQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of welfareQueries) expect(query).not.toContain("in('zone_id'");
    expect(source).toContain('Welfare and CCTV processing are organization-wide.');
  });

  it('locks the console viewport and gives the master-detail panes their own scroll ownership', () => {
    expect(shellCss).toMatch(/\.admin-shell\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s);
    expect(css).toContain('height: 100%;');
    expect(css).toContain('min-height: 0;');
    expect(css).toContain('grid-template-columns: minmax(280px,35fr) minmax(0,65fr)');
    expect(css).toMatch(/\.admin-pane-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toContain('flex: 0 0 52px');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).not.toContain('max-width: 1320px');
    expect(source).toContain('Review, approve or assign in the governed record.');
  });
});