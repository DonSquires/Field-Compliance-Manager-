import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerFreedomCampingPage.tsx'), 'utf8');
const scanFunction = readFileSync(resolve(process.cwd(), '../../supabase/functions/process-officer-scan/index.ts'), 'utf8');

describe('Officer Freedom Camping interaction boundary', () => {
  it('routes new observations through the complete scan edge function', () => {
    expect(source).toContain("functions.invoke<OfficerScanResult>('process-officer-scan'");
    expect(source).not.toContain("rpc('calculate_vehicle_compliance'");
    expect(source).not.toMatch(/from\('observations'\)[\s\S]{0,200}\.insert\(/);
  });

  it('keeps camera, offline queue, and all schema verdict states visible', () => {
    expect(source).toContain('capture="environment"');
    expect(source).toContain('queueOfficerScan(payload)');
    for (const status of ['compliant', 'at_risk', 'breach', 'breach_exempt', 'unknown']) {
      expect(source).toContain(`${status}:`);
    }
  });

  it('preserves capture time separately from queue synchronization time', () => {
    expect(scanFunction).toContain('captured_at: capturedAt');
    expect(scanFunction).toContain('const observedAt = capturedDate.toISOString()');
    expect(source).toContain('synced_at: new Date().toISOString()');
  });
});