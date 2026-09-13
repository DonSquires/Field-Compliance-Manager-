import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerMapPage.tsx'), 'utf8');

describe('officer team GPS map', () => {
  it('loads team positions from the officer organization GPS log', () => {
    expect(source).toContain("from('officer_gps_log')");
    expect(source).toContain(".eq('organization_id', orgId)");
    expect(source).toContain('latestByOfficer');
    expect(source).toContain('positions.length');
  });

  it('enriches GPS positions with officer display names', () => {
    expect(source).toContain("from('user_profiles')");
    expect(source).toContain('.select(\'id, display_name\')');
    expect(source).toContain('officer_name: names[row.officer_id]');
  });

  it('shows team positions and mine separately', () => {
    expect(source).toContain("(row.officer_id === profile.id ? 'You' : row.officer_id)");
    expect(source).toContain('Team Map');
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(source).toContain('if (!orgId) {');
    expect(source).toContain("setError('Organisation access could not be confirmed. Team positions are unavailable.');");
    expect(source).toContain('setLoading(false);');
  });
});
