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
    expect(source).toContain('queueOfficerScan(payload, profile?.id)');
    expect(source).toContain('listQueuedOfficerScans(profile.id)');
    expect(source).toContain("scan.status === 'needs_review'");
    expect(source).not.toContain("console.log('Scanned:'");
  });

  it('limits the UI to the two server-supported scan branches', () => {
    expect(source).toContain("key === 'freedom_camping' || key === 'parking_enforcement'");
  });

  it('surfaces closure evidence without replacing the module verdict', () => {
    expect(source).toContain('result.zone_closed');
    expect(source).toContain('result.zone_closure?.closure_type');
    expect(source).toContain('Verdict remains rule-derived.');
  });

  it('renders each geofence resolution outcome distinctly (GEOFENCE_PRINCIPLES P1)', () => {
    for (const outcome of ['resolved', 'outside_all_geofences', 'unresolved_no_geofence', 'unresolved_unverified', 'unresolved_invalid', 'not_evaluated']) expect(source).toContain(`${outcome}:`);
    expect(source).toContain("RESOLUTION_LABEL[result.resolution_status ?? '']");
    expect(source).toContain('result.geofence_notice &&');
    expect(source).toContain('result.governor_overlap_flag &&');
    expect(source).not.toContain('No configured zone');
  });
});