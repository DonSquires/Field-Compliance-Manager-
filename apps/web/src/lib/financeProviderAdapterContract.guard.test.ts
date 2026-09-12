import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912136000_finance_provider_adapter_contract.sql'), 'utf8');

describe('finance provider adapter contract', () => {
  it('lets a server-side provider adapter complete a connection without storing credentials', () => {
    expect(migration).toContain('provider_connection_reference');
    expect(migration).toContain('complete_finance_external_connection');
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('credentials_stored_in_browser');
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.complete_finance_external_connection");
  });

  it('records sync success or failure through a service-only boundary', () => {
    expect(migration).toContain('record_finance_external_sync');
    expect(migration).toContain('sync_cursor');
    expect(migration).toContain('last_error');
    expect(migration).toContain('finance_external_sync_recorded');
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.record_finance_external_sync");
  });
});
