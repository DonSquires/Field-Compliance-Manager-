import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerDispatchPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901000000_dispatch_completion_continuity.sql'), 'utf8');

describe('officer dispatch lifecycle boundary', () => {
  it('uses the server-owned race-checked transition RPC', () => {
    expect(source).toContain("rpc('advance_dispatch_job_status'");
    expect(source).toContain('p_expected_status: job.status');
    expect(source).not.toMatch(/from\('dispatch_jobs'\)[\s\S]{0,220}\.update\(/);
  });

  it('acknowledges before moving en route and confirms the response', () => {
    expect(source).toContain("dispatched: 'acknowledged'");
    expect(source).toContain("acknowledged: 'en_route'");
    expect(source).toContain('status change was not confirmed');
  });

  it('requires an officer outcome before completing a job', () => {
    expect(source).toContain('Record the dispatch outcome before completing the job.');
    expect(source).toContain("p_outcome_notes: nextStatus === 'completed' ? outcome : null");
    expect(source).toContain('placeholder="Record actions taken and the verified outcome"');
  });

  it('preserves shift context and onward commands after completion', () => {
    expect(source).toContain('result.shift_id');
    expect(source).toContain('Your shift remains active');
    for (const destination of ['home', 'map', 'report', 'debrief']) {
      expect(source).toContain(`onNavigate?.('${destination}')`);
    }
  });

  it('returns the locked job context without widening RPC access', () => {
    expect(migration).toContain('returns table (id uuid, status text, shift_id uuid, completed_at timestamptz)');
    expect(migration).toContain('select updated.id, updated.status, updated.shift_id, updated.completed_at');
    expect(migration).toContain('revoke all on function public.advance_dispatch_job_status(uuid, text, text, text) from public, anon;');
    expect(migration).toContain('to authenticated, service_role;');
  });
});