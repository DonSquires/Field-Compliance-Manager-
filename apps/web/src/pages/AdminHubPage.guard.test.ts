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
});