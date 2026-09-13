import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerOvernightVerificationPage.tsx'), 'utf8');

describe('officer overnight verification workspace', () => {
  it('fails closed when organization context is unavailable', () => {
    expect(source).toContain('if (!orgId) {');
    expect(source).toContain("setError('Organisation access could not be confirmed. Overnight verification is unavailable.');");
    expect(source).toContain('setLoading(false);');
  });
});
