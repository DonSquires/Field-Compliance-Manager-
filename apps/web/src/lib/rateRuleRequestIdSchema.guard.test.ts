import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905006200_add_rate_rule_request_id.sql'), 'utf8');

describe('rate rule request identity', () => {
  it('provides the idempotency column and unique branch request key used by governed rate APIs', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS client_request_id uuid');
    expect(migration).toContain('idx_rate_rules_client_request');
    expect(migration).toContain('(organization_id,client_request_id)');
  });
});