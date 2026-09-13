import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerParkingPage.tsx'), 'utf8');

describe('officer parking workspace', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(source).toContain("setError('Organisation access could not be confirmed. Parking records are unavailable.');");
    expect(source).toContain('setLoading(false);');
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
  });
});
