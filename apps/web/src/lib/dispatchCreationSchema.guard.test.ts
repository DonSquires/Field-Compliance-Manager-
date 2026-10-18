import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830091000_create_dispatch_job_rpc.sql'), 'utf8');

describe('atomic dispatch creation schema', () => {
  it('deduplicates client retries and validates authority plus active contract location', () => {
    expect(migration).toContain('client_request_id');
    expect(migration).toContain('idx_dispatch_jobs_client_request');
    expect(migration).toContain('is_admin_for_org');
    expect(migration).toContain("sal.status = 'active'");
    expect(migration).toContain('cs.active = true');

    // Live: create_dispatch_job is a Site-only wrapper over create_dispatch_job_for_place, which
    // owns the same rules for a Site or a Zone (the catalog dump renders `= true` as a bare boolean).
    expect(schema).toContain('idx_dispatch_jobs_client_request');
    expect(schema).toMatch(/create_dispatch_job"\([^)]*\)[\s\S]*?create_dispatch_job_for_place\(/);
    const placeRpc = schema.match(/CREATE OR REPLACE FUNCTION "public"\."create_dispatch_job_for_place"[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(placeRpc).toContain('is_admin_for_org(p_organization_id)');
    expect(placeRpc).toContain('client_request_id = p_client_request_id');
    expect(placeRpc).toContain("link.status = 'active'");
    expect(placeRpc).toMatch(/link\.site_id = p_client_site_id AND site\.active/);
    expect(placeRpc).toMatch(/link\.zone_id = p_zone_id AND zone\.is_active/);
  });

  it('owns the SLA deadline on the server', () => {
    expect(migration).toContain('now() + make_interval(mins => p_sla_minutes)');
  });
});