import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015005951_retire_duplicate_open_jobs_rpc.sql'),
  'utf8',
);
const manifest = readFileSync(resolve(process.cwd(), '../../supabase/schemas/.pgdelta-export.json'), 'utf8');
const databaseTypes = readFileSync(resolve(process.cwd(), '../../src/types/database.ts'), 'utf8');
const dispatchPage = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');
const coveragePage = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');

describe('retired mixed open-jobs queue', () => {
  it('drops the duplicate RPC without cascade and removes resurrection sources', () => {
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.get_open_jobs(integer, integer);');
    expect(migration).not.toContain('CASCADE');
    expect(manifest).not.toContain('get_open_jobs.sql');
    expect(databaseTypes).not.toContain('get_open_jobs:');
    expect(existsSync(resolve(process.cwd(), '../../supabase/schemas/public/functions/get_open_jobs.sql'))).toBe(false);
  });

  it('retains separate canonical dispatch and shift-coverage workflows', () => {
    expect(dispatchPage).toContain(".from('dispatch_jobs')");
    expect(dispatchPage).toContain("supabase.rpc('insert_adhoc_stop'");
    expect(coveragePage).toContain('shift_coverage_requests');
    expect(dispatchPage).not.toContain("rpc('get_open_jobs'");
    expect(coveragePage).not.toContain("rpc('get_open_jobs'");
  });
});
