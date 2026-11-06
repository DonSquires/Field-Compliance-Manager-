import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerDispatchPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901000000_dispatch_completion_continuity.sql'), 'utf8');

describe('officer dispatch lifecycle boundary', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile?.organizationId) {");
    expect(source).toContain("setError('Organisation access could not be confirmed. Dispatch jobs are unavailable.');");
    expect(source).toContain('setLoading(false);');
  });

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

  it('opens and focuses the exact personally delivered dispatch job', () => {
    expect(source).toContain("get('job')");
    expect(source).toContain('id={`officer-dispatch-${job.id}`}');
    expect(source).toContain('const isFocused = job.id === requestedJobId;');
    expect(source).toContain("${isFocused ? 'is-context-focus' : ''}");
  });

  it('shows location, access, and safety context before attendance', () => {
    expect(source).toContain('site:client_site_id(name, address, hs_notes, access_instructions)');
    expect(source).toContain('zone:zone_id(name, zone_type)');
    expect(source).toContain('site: site ?? (zone ?');
    expect(source).toContain('Access: {job.site.access_instructions}');
    expect(source).toContain('Safety: ');
    expect(source).toContain("const briefHeading = rank >= 3 ? 'On-site notes' : 'Before you arrive';");
  });

  it('walks the officer through the job in plain words with one action at a time', () => {
    expect(source).toContain("acknowledged: 'On my way'");
    expect(source).toContain("en_route: 'Arrived on site'");
    expect(source).toContain("on_scene: 'Complete job'");
    expect(source).toContain("{ rank: 1, label: 'Acknowledge' }");
    expect(source).toContain("{ rank: 4, label: 'Complete' }");
    expect(source).toContain("aria-current={state === 'next' ? 'step' : undefined}");
    expect(source).toContain("tone: 'overdue', label: `Response time passed at ${time}`");
    expect(source).toContain('elapsed >= 0.75');
    expect(source).toContain('Back to shift home');
    expect(source).not.toContain('<h3>{job.job_type}</h3>');
  });

  it('lets the officer record people involved on the job and after completing it', () => {
    expect(source).toContain('<section className="officer-dispatch-people" aria-label="People involved">');
    expect(source).toContain('<PersonInteractionForm organizationId={job.organization_id} dispatchJobId={job.id} />');
    expect(source).toContain('<PersonInteractionForm organizationId={completionReceipt.organizationId} dispatchJobId={completionReceipt.id} />');
    expect(source).toContain("select('id, organization_id, job_type");
  });

  it('returns the locked job context without widening RPC access', () => {
    expect(migration).toContain('returns table (id uuid, status text, shift_id uuid, completed_at timestamptz)');
    expect(migration).toContain('select updated.id, updated.status, updated.shift_id, updated.completed_at');
    expect(migration).toContain('revoke all on function public.advance_dispatch_job_status(uuid, text, text, text) from public, anon;');
    expect(migration).toContain('to authenticated, service_role;');
  });
});