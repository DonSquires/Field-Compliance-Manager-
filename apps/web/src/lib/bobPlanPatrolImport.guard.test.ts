import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-plan-patrol-import/index.ts'), 'utf8');

describe('Bob patrol import planner', () => {
  it('resolves patrol sources against canonical site references without writing', () => {
    expect(edge).toContain("/functions/v1/bob-plan-import");
    expect(edge).toContain('bob_capability_map');
    expect(edge).toContain('bob_app_map_edges');
    expect(edge).not.toContain("row['Client Name']");
    expect(edge).not.toContain("from('client_sites')");
    expect(edge).toContain('writes: []');
    expect(edge).toContain('Read-only Atlas-backed patrol planning delegated to the generic schema-driven Bob planner');
  });
});
