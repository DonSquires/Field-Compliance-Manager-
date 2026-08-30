import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830090000_create_dispatch_job_rpc.sql'), 'utf8');

describe('atomic dispatch creation schema', () => {
  it('deduplicates client retries and validates authority plus active contract location', () => {
    for (const source of [schema, migration]) {
      expect(source).toContain('client_request_id');
      expect(source).toContain('idx_dispatch_jobs_client_request');
      expect(source).toContain('is_admin_for_org');
      expect(source).toContain("sal.status = 'active'");
      expect(source).toContain('cs.active = true');
    }
  });

  it('owns the SLA deadline on the server', () => {
    expect(migration).toContain('now() + make_interval(mins => p_sla_minutes)');
  });
});