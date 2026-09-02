/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/hooks/useWelfareCheckin.ts'), 'utf8');

describe('useWelfareCheckin schema and write handling', () => {
  it('writes the current welfare_checks schema columns', () => {
    for (const column of ['organization_id', 'officer_user_id', 'gps_lat', 'gps_lng', 'checked_in_at']) {
      expect(source).toContain(column);
    }
    expect(source).not.toContain('gps_latitude');
    expect(source).not.toContain('gps_longitude');
    expect(source).not.toContain('checked_at');
  });

  it('surfaces failed or unconfirmed writes instead of only logging them', () => {
    expect(source).toContain('if (error) throw error');
    expect(source).toContain("if (!data) throw new Error('Welfare check-in was not confirmed.')");
    expect(source).toContain('setError(message)');
    expect(source).toContain('return false');
  });
});