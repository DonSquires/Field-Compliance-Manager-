import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830060000_add_scan_operator_role.sql'), 'utf8');

describe('canonical user role schema', () => {
  it('supports the routed scan_operator role in schema and migration', () => {
    expect(schema).toMatch(/user_profiles_role_check[\s\S]*?'scan_operator'/);
    expect(migration).toContain("'scan_operator'::text");
  });
});