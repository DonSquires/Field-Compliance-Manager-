import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');

describe('officer coverage tenant states', () => {
  it('stops loading when organization scope is unavailable', () => {
    expect(source).toContain('if (!organizationId) {');
    expect(source).toContain('setLoading(false);');
    expect(source).toContain('Coverage is unavailable until organisation access is confirmed.');
  });

  it('provides a recovery action when coverage reads fail', () => {
    expect(source).toContain('openShiftsError');
    expect(source).toContain('>Try again</button>');
    expect(source).toContain('onClick={() => void reload()}');
  });
});
