import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerFreedomCampingPage.tsx'), 'utf8');
const scanFunction = readFileSync(resolve(process.cwd(), '../../supabase/functions/process-officer-scan/index.ts'), 'utf8');

describe('Officer Freedom Camping interaction boundary', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(source).toContain("setHistoryError('Organisation access could not be confirmed. Recent scans are unavailable.');");
    expect(source).toContain('setLoadingHistory(false);');
  });

  it('routes new observations through the complete scan edge function', () => {
    expect(source).toContain("functions.invoke<OfficerScanResult>('process-officer-scan'");
    expect(source).not.toContain("rpc('calculate_vehicle_compliance'");
    expect(source).not.toMatch(/from\('observations'\)[\s\S]{0,200}\.insert\(/);
  });

  it('keeps camera, offline queue, and all schema verdict states visible', () => {
    expect(source).toContain('capture="environment"');
    expect(source).toContain('queueOfficerScan(payload, profile?.id)');
    expect(source).toContain('listQueuedOfficerScans(profile.id)');
    expect(source).toContain('Photo retained on this device.');
    for (const status of ['compliant', 'at_risk', 'breach', 'breach_exempt', 'unknown']) {
      expect(source).toContain(`${status}:`);
    }
  });

  it('lets typed addresses feed the existing coordinate-based scan path', () => {
    expect(source).toContain('resolveAddressCandidates(addressQuery, 5)');
    expect(source).toContain('latitude: candidate.lat');
    expect(source).toContain('longitude: candidate.lng');
  });

  it('preserves capture time separately from queue synchronization time', () => {
    expect(scanFunction).toContain('captured_at: capturedAt');
    expect(scanFunction).toContain('const observedAt = capturedDate.toISOString()');
    expect(source).toContain('synced_at: new Date().toISOString()');
  });

  it('surfaces closure evidence without replacing the compliance verdict', () => {
    expect(source).toContain('result.zone_closed');
    expect(source).toContain('result.zone_closure?.closure_type');
    expect(source).toContain('The compliance verdict remains rule-derived.');
  });

  it('keeps the requested-breach scroll effect at component scope instead of nesting it inside the async loader', () => {
    expect(source).not.toMatch(/const loadHistory = useCallback\(async \(\) => \{[\s\S]*?useEffect\(\(\) => \{ if \(requestedBreachId\)/);
  });

  it('submits officer enforcement through the governed mode resolver path', () => {
    expect(source).toContain("rpc('submit_officer_breach_action'");
    expect(source).toContain("p_expected_status: 'open'");
    expect(source).toContain('p_request_id: enforcementRequestId');
    expect(source).toContain("disposition === 'direct'");
    expect(source).toContain('Administrator review requested');
    expect(source).not.toMatch(/from\('breach_alerts'\)[\s\S]{0,300}\.update\(/);
  });

  it('requires preview and exact typed-name authorization before officer printing', () => {
    expect(source).toContain("operation: 'preview'");
    expect(source).toContain("operation: 'authorize_print'");
    expect(source).toContain('typedAuthorizerName !== profile?.displayName');
    expect(source).toContain('print_request_id: printRequestId');
    expect(source).toContain('Authorize Print');
    expect(source).toContain('<NoticePrintActions');
  });
});