import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerParkingPage.tsx'), 'utf8');

describe('OfficerParkingPage', () => {
  it('submits through the real process-officer-scan pipeline, not a manual insert', () => {
    expect(source).toContain("functions.invoke<ParkingScanResult>('process-officer-scan'");
    expect(source).toContain("moduleKey: 'parking_enforcement'");
    expect(source).not.toContain("from('parking_chalk_records').insert(");
    expect(source).not.toContain("from('parking_chalk_records').update(");
  });

  it('captures photo evidence and GPS, mirroring OfficerFreedomCampingPage', () => {
    expect(source).toContain('imageFileToBase64');
    expect(source).toContain('type="file"');
    expect(source).toContain('capture="environment"');
    expect(source).toContain('getCurrentPosition()');
  });

  it('supports offline queueing scoped to parking scans', () => {
    expect(source).toContain('queueOfficerScan(payload)');
    expect(source).toContain("scan.body.module_key !== 'parking_enforcement'");
  });

  it('surfaces the server-computed overstay verdict and vehicle compliance flags instead of letting the officer set status', () => {
    expect(source).toContain('result.is_overstay');
    expect(source).toContain('result.vehicle_compliance_flags');
    expect(source).toContain('result.breach_alert_id');
  });
});
