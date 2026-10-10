import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AdminHubPage.tsx'), 'utf8');

describe('Admin Hub operational data contract', () => {
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
    expect(source).toContain('Some active safety, dispatch, or compliance counts are unavailable.');
  });

  it('does not leave the operations landing page in an indefinite loading state without tenant scope', () => {
    expect(source).toContain('Organisation access could not be confirmed. Operational metrics are unavailable.');
    expect(source).toContain('setQueueWarnings([message]);');
    expect(source).toContain('setLoading(false);');
  });

  it('keeps live work ahead of supporting metrics without a duplicate shortcut directory', () => {
    expect(source.indexOf('className="admin-overview-layout"')).toBeLessThan(source.indexOf('className="admin-dashboard"'));
    expect(source).toContain('<h2>Quick actions</h2>');
    expect(source).not.toContain('Command Centre');
    expect(source).not.toContain('ADMIN_COMMAND_CENTRE_GROUPS');
  });

  it('does not offer navigation from an unavailable welfare metric', () => {
    expect(source).toMatch(/renderUnavailable=\{\(message\) => <MetricCard[^>]+label="Welfare alerts"[^>]+tone="red" \/>\}/);
  });

  it('queries welfare organization-wide because welfare alerts have no zone column', () => {
    const welfareQueries = source.split('\n').filter((line) => line.includes("from('welfare_alerts')"));
    expect(welfareQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of welfareQueries) expect(query).not.toContain("in('zone_id'");
    expect(source).toContain('Welfare and CCTV processing are organization-wide.');
  });
});