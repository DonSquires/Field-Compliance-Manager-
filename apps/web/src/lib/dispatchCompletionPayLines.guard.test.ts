import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'supabase')) ? process.cwd() : resolve(process.cwd(), '../..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20260908006000_resolve_dispatch_pay_on_completion.sql'), 'utf8');

describe('dispatch completion pay resolution', () => {
  it('resolves idempotent pay lines when a dispatch job becomes completed', () => {
    const start = migration.indexOf('create or replace function public.advance_dispatch_job_status');
    const source = migration.slice(start);
    expect(source).toContain("if p_next_status = 'completed' then");
    expect(source).toContain('perform public.resolve_dispatch_job_pay_lines(gen_random_uuid(), p_job_id, null);');
  });

  it('allows the completing assigned officer to resolve a completed job pay snapshot', () => {
    const start = migration.indexOf('create or replace function public.resolve_dispatch_job_pay_lines');
    const end = migration.indexOf('create or replace function public.advance_dispatch_job_status', start);
    const source = migration.slice(start, end);
    expect(source).toContain('v_job.assigned_officer_id is distinct from auth.uid()');
  });
});
