import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912145000_akahu_apply_application_ledger.sql'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-application/index.ts'), 'utf8');

describe('Akahu Apply application ledger', () => {
  it('keeps the external application tenant-scoped and idempotent', () => {
    expect(migration).toContain('finance_akahu_apply_applications');
    expect(migration).toContain('UNIQUE (organization_id, reference)');
    expect(migration).toContain("^application_[a-z0-9]{24,27}$");
    expect(edge).toContain(".eq('organization_id', profile.organization_id).eq('reference', reference)");
  });

  it('creates Apply applications server-side and records an audit event', () => {
    expect(edge).toContain("Deno.env.get('AKAHU_APPLY_API_KEY')");
    expect(edge).toContain("fetch(`${applyBase}/applications`");
    expect(edge).toContain("body: JSON.stringify({ reference })");
    expect(edge).toContain('finance_akahu_apply_application_created');
    expect(edge).not.toContain('return json({ applyApiKey');
  });
});
