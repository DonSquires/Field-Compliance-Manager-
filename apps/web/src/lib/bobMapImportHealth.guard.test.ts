import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-map-import/index.ts'), 'utf8');

describe('Bob mapping tool health', () => {
  it('bounds schema inspection so value mapping does not time out on FK metadata', () => {
    expect(edge).toContain('include_fks: false');
  });
});