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

  it('elevates the officer’s next assigned dispatch job before generic tools', () => {
    expect(source).toContain("from('dispatch_jobs')");
    expect(source).toContain(".eq('assigned_officer_id', officerId)");
    expect(source).toContain('zone:zone_id(name)');
    expect(source).toContain('site: site ?? (zone ?');
    expect(source).toContain('Your next job');
    expect(source).toContain('Open and acknowledge job');
    expect(source).toContain('nextDispatchError');
  });
});
