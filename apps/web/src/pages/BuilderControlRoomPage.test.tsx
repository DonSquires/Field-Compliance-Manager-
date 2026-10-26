import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import BuilderControlRoomPage from './BuilderControlRoomPage';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke } } }));
vi.mock('../components/BuilderChatPanel', () => ({ BuilderChatPanel: () => null }));
vi.mock('../components/ChangeRequestQueue', () => ({ ChangeRequestQueue: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each(['missing', 'blocked', 'covered'])('shows %s acceptance honestly at the same-job correction gate', async state => {
  const job = { id: 'review-job', project_id: 'project', title: 'Review repair', status: 'security_review',
    target_sha: 'a'.repeat(40), code_review_mode: 'human', code_review_status: 'pending',
    created_at: '2026-10-26T12:00:00Z', updated_at: '2026-10-26T12:00:00Z' };
  const report = { version: 1, passed: state === 'covered',
    requirements: [{ requirement_id: 'DR-1', status: state === 'covered' ? 'covered' : 'blocked' }],
    blockers: state === 'covered' ? [] : ['DR-1: diary-save/final-failure workflow absent'] };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job,
      steps: [{ id: 'test', step_id: 'test_suite', status: 'completed', ordinal_position: 5, builder_mode: 'qa_security_reviewer',
        input_context: state === 'missing' ? {} : { implementation_acceptance: { report } } }],
      artifacts: [{ id: 'patch', artifact_type: 'code_implementation', status: 'final', checksum: 'b'.repeat(64) }],
      workerRuns: [], approvals: [{ id: 'review', approval_type: 'implementation_review', status: 'pending',
        triggered_at_status: 'security_review', requested_target_sha: job.target_sha, reviewed_artifact_ids: ['patch'] }] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  const approve = await screen.findByRole('button', { name: 'Approve' });
  expect(approve.hasAttribute('disabled')).toBe(state !== 'covered');
  expect(screen.queryByText('Is the finished code acceptable?')).toBeNull();
  if (state !== 'covered') {
    expect(screen.getByRole('alert', { name: 'Acceptance corrections required' })).toBeTruthy();
    expect(screen.getByText(/Ask Builder Chat for corrections on this same job/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Note for Bob/ }), { target: { value: 'Please correct the workflow on this same job.' } });
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(false);
  } else {
    expect(screen.getByText(/server rechecks its evidence identity/)).toBeTruthy();
  }
  expect(invoke.mock.calls.every(([, { body }]) => ['get', 'list', 'context_snapshot'].includes(body.action))).toBe(true);
});

it.each(['driving', 'blocked', 'awaiting_human', 'done'])('does not call a monitor job undriven when scheduler state is %s', async state => {
  const now = new Date().toISOString();
  const job = {
    id: 'monitor-job', project_id: 'project', title: 'Monitor repair', status: 'implementation_pending',
    target_sha: 'a'.repeat(40), current_step_name: 'ui_design', autopilot_state: state, autopilot_requested_by: null,
    created_at: now, updated_at: now,
  };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Monitor repair' });
  await waitFor(() => {
    expect(screen.queryByText(/Nobody is driving this job yet/)).toBeNull();
    expect(screen.getByText(state === 'driving' ? /Bob autopilot is assigned/ : state === 'blocked' ? /Bob is blocked. Inspect/ : state === 'awaiting_human' ? /Bob is waiting for a human decision/ : /Autopilot stopped on this record. Review its outcome/)).toBeTruthy();
  });
});

it.each([
  ['Run next step', 'advance', false],
  ['Run to gate', 'run', false],
  ['Run next step', 'advance', true],
])('reports background acceptance truthfully for %s (already running: %s)', async (button, action, alreadyRunning) => {
  const job = {
    id: 'active-job', project_id: 'project', title: 'Active repair', status: 'implementation_pending',
    target_sha: 'a'.repeat(40), frontend_required: true, backend_required: false,
    current_step_name: 'ui_design', code_review_status: 'pending',
    created_at: '2026-10-18T01:00:00Z', updated_at: '2026-10-18T01:00:00Z',
  };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === action) return { data: { accepted: true, already_running: alreadyRunning }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  fireEvent.click(await screen.findByRole('button', { name: button }));
  await screen.findByText(alreadyRunning ? /No duplicate run was started/ : /accepted. Bob will work in the background/);
  expect(screen.queryByText(/^Builder (run|step) completed\.$/)).toBeNull();
  expect(invoke.mock.calls.some(([, { body }]) => body.action === action && body.job_id === job.id)).toBe(true);
});

it('treats a cancelled job with stale failures and pending approvals as history, not actionable work', async () => {
  const job = {
    id: 'cancelled-job', project_id: 'project', title: 'Cancelled repair',
    status: 'cancelled', target_sha: 'a'.repeat(40), workspace_branch: 'bob/job-12345678',
    frontend_required: true, backend_required: false,
    current_step_name: 'frontend_implementation', code_review_status: 'pending',
    last_error: 'Cancelled: duplicate job', created_at: '2026-10-18T01:00:00Z', updated_at: '2026-10-18T01:00:00Z',
  };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return {
      data: {
        job,
        steps: [{ id: 'step', step_id: 'frontend_implementation', ordinal_position: 3, builder_mode: 'frontend_engineer', status: 'failed', error: 'Worker lease expired', attempt_count: 3 }],
        artifacts: [{ id: 'patch', artifact_type: 'code_implementation', status: 'final', checksum: 'b'.repeat(64), content_size_bytes: 20 }], workerRuns: [],
        approvals: [{ id: 'approval', status: 'pending', approval_type: 'specification_review', reviewed_artifact_ids: [] }],
      },
      error: null,
    };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByText('Cancelled - no action required');
  expect(screen.getByText(/This job was cancelled. No approval or retry is required/)).toBeTruthy();
  expect(screen.queryByText('Recovery needed')).toBeNull();
  expect(screen.queryByText('Human approval required')).toBeNull();
  for (const name of ['Run next step', 'Run to gate', 'Continue build', 'Create workspace', 'Approve', 'Reject']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  fireEvent.click(screen.getByRole('button', { name: 'Files & changes' }));
  expect(screen.queryByRole('button', { name: 'Commit verified patch' })).toBeNull();
  expect(screen.getByRole('button', { name: /code implementation/ })).toBeTruthy();
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(invoke.mock.calls.every(([, { body }]) => ['list', 'get', 'context_snapshot'].includes(body.action))).toBe(true);
});
