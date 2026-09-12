import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-plan-patrol-import/index.ts'), 'utf8');

describe('Bob patrol import planner', () => {
  it('resolves patrol sources against canonical site references without writing', () => {
    expect(edge).toContain("from('client_sites')");
    expect(edge).toContain("from('service_agreements')");
    expect(edge).toContain('external_ref');
    expect(edge).toContain('unresolved_count');
    expect(edge).toContain('writes: []');
    expect(edge).toContain('Read-only patrol mapping plan');
  });
});
