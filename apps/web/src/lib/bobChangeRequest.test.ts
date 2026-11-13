import { describe, expect, it, vi } from 'vitest';
import { bobEvaluationPrompt, buildChangeRequestEnvelope, canRequestChange, captureViewContext, changeRequestStatusLabel, listChangeRequests, type ChangeRequestRecord } from './bobChangeRequest';

vi.mock('./supabase', () => ({ supabase: {} }));

describe('page change briefs', () => {
  it('captures bounded view structure without URL queries, inputs or table contents', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    window.history.replaceState({}, '', '/admin/roster?private=secret#person');
    document.title = 'Roster';
    document.body.innerHTML = '<main data-app-content><h1>Roster board</h1><input value="secret"><table><tbody><tr><td><h2>Private employee</h2></td></tr></tbody></table><button role="tab" aria-selected="true">Week</button><div role="dialog"><h2>Do not capture</h2></div><div data-bob-private><h2>Private detail</h2></div></main>';
    const context = captureViewContext('Dispatch');
    expect(context.page).toBe('/admin/roster');
    expect(context.view_headings).toEqual(['Roster board']);
    expect(context.active_tab).toBe('Week');
    expect(JSON.stringify(context)).not.toMatch(/secret|Private employee|Do not capture/);
    const envelope = buildChangeRequestEnvelope({ kind: 'workflow_snag', currentBehavior: 'Mixed list', desiredBehavior: 'Unfilled shifts first', businessReason: 'Faster dispatch' }, context);
    expect(envelope.during.user_report.desired_behavior).toBe('Unfilled shifts first');
    expect(envelope).not.toHaveProperty('organization_id');
  });
  it('keeps role access explicit and personal lists fail closed without an identity', async () => {
    expect(canRequestChange('officer')).toBe(true);
    expect(canRequestChange('client_viewer')).toBe(false);
    expect(canRequestChange(null)).toBe(false);
    await expect(listChangeRequests({ mineOnly: true })).rejects.toThrow('Sign in');
  });
  it('separates untrusted feedback from authority to execute', () => {
    const record: ChangeRequestRecord = {
      id: 'request-1', organization_id: 'org-1', user_id: 'user-1', created_at: '', triage: 'ux_gap',
      repair_risk: 'significant', automation_status: 'awaiting_grandmaster', stop_line_hit: null,
      disposition: 'open', builder_job_id: null, reviewed_at: null, review_note: null,
      kind: 'change_request', page: '/admin/roster', headings: [], desiredBehavior: 'Group open shifts',
      currentBehavior: 'Mixed shifts', businessReason: 'Faster planning', viewTitle: 'Roster',
    };
    const prompt = bobEvaluationPrompt(record);
    expect(prompt).toContain('untrusted user feedback');
    expect(prompt).toContain('RLS and role access');
    expect(prompt).toContain('Do not open a job');
    expect(prompt).toContain('request-1');
  });
  it('shows where an automatically routed request is in the Builder lane', () => {
    const base = { disposition: 'open', builder_job_id: null, repair_risk: 'significant', automation_status: 'awaiting_grandmaster', stop_line_hit: null } as const;
    expect(changeRequestStatusLabel(base)).toBe('Queued for Bob Builder chat');
    expect(changeRequestStatusLabel({ ...base, automation_status: 'claimed' })).toBe('Bob is assessing in Builder chat');
    expect(changeRequestStatusLabel({ ...base, automation_status: 'failed' })).toBe('Bob did not open a job — waiting for review');
    expect(changeRequestStatusLabel({ ...base, stop_line_hit: 'payroll' })).toBe('Waiting for review (stop line)');
    expect(changeRequestStatusLabel({ ...base, repair_risk: 'protected' })).toBe('Waiting for platform review (protected area)');
    expect(changeRequestStatusLabel({ ...base, builder_job_id: 'job-1', automation_status: 'builder_started' })).toBe('Builder job opened');
    expect(changeRequestStatusLabel({ ...base, disposition: 'reviewing' })).toBe('Under review');
  });
});
