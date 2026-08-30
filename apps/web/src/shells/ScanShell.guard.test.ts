import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/shells/ScanShell.tsx'), 'utf8');

describe('ScanShell standalone contract', () => {
  it('loads only enabled standalone service-agreement modules', () => {
    expect(source).toContain(".from('service_agreement_modules')");
    expect(source).toContain(".eq('enabled', true)");
    expect(source).toContain(".eq('standalone_scan_enabled', true)");
  });

  it('uses the complete scan edge function and shared offline queue', () => {
    expect(source).toContain("functions.invoke<ScanResult>('process-officer-scan'");
    expect(source).toContain('queueOfficerScan(payload)');
    expect(source).toContain('listQueuedOfficerScans()');
    expect(source).not.toContain("console.log('Scanned:'");
  });

  it('limits the UI to the two server-supported scan branches', () => {
    expect(source).toContain("key === 'freedom_camping' || key === 'parking_enforcement'");
  });
});