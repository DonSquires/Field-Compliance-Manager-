import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AccessControlPage.tsx'), 'utf8');

describe('branch access control loader', () => {
  it('clears loading state when operating branch context is unavailable', () => {
    expect(source).toContain('if (!orgId || !operatingBranchId) {');
    expect(source).toContain('setLoading(false);');
    expect(source).toContain('setError(null);');
  });
});
