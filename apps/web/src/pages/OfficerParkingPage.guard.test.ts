import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, 'OfficerParkingPage.tsx'), 'utf8');

describe('OfficerParkingPage governed capture', () => {
  it('submits place-bound evidence through the canonical Parking scan pipeline', () => {
    expect(source).toContain("moduleKey: 'parking_enforcement'");
    expect(source).toContain("supabase.functions.invoke<ParkingScanResult>('process-officer-scan'");
    expect(source).toContain('imageFileToBase64');
    expect(source).toContain('getCurrentPosition');
    expect(source).toContain('relationships.zones');
  });

  it('does not bypass server-owned compliance with direct chalk mutations', () => {
    expect(source).not.toMatch(/\.from\(['"]parking_chalk_records['"]\)\s*\.insert/);
    expect(source).not.toMatch(/\.from\(['"]parking_chalk_records['"]\)\s*\.update/);
  });
});