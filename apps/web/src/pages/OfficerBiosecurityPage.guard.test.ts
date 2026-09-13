import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerBiosecurityPage.tsx'), 'utf8');

describe('officer biosecurity workspace', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(source).toContain("setError('Organisation access could not be confirmed. Biosecurity assessments are unavailable.');");
    expect(source).toContain('setLoading(false);');
  });
});
