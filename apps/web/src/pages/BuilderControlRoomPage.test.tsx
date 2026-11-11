import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BuilderControlRoomPage, { failedFrontendPatchRetryCandidate } from './BuilderControlRoomPage';

const { invoke, rpc, getUser } = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke }, rpc, auth: { getUser } } }));
vi.mock('../components/BuilderChatPanel', () => ({ BuilderChatPanel: () => null }));
vi.mock('../components/ChangeRequestQueue', () => ({ ChangeRequestQueue: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(() => { getUser.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null }); });

it('shows the persistent Builder reference in the queue and workbench and searches by it', async () => {
  const jobs = [
    { id: 'newer', human_reference: 'BB-103', project_id: 'project', title: 'Recent work',
      status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
    { id: 'older', human_reference: 'BB-4', project_id: 'project', title: 'Older work',
      status: 'failed', target_sha: 'b'.repeat(40), created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
  ];
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs, projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: jobs.find(job => job.id === body.job_id), steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  expect(await screen.findByRole('button', { name: /BB-103.*Recent work/ })).toBeTruthy();
  await screen.findByRole('heading', { name: 'Recent work' });
  expect(screen.getByText('Reference: BB-103')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: 'bb-4' } });
  expect(screen.getByRole('button', { name: /BB-4.*Older work/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Recent work/ })).toBeNull();
});

it('saves an edited job name without changing its reference', async () => {
  let job = { id: 'job', human_reference: 'BB-103', project_id: 'project', title: 'Original work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'rename') {
      expect(body).toMatchObject({ job_id: 'job', expected_title: 'Original work', title: 'Clearer work' });
      job = { ...job, title: 'Clearer work' };
      return { data: { job }, error: null };
    }
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Original work' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit job name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: '  Clearer work  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('heading', { name: 'Clearer work' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /BB-103.*Clearer work/ })).toBeTruthy();
  expect(screen.getByText('Reference: BB-103')).toBeTruthy();
  expect(screen.getByText(/Name saved for BB-103/i)).toBeTruthy();
});

it('keeps an edited job name as a draft when the server rejects the change', async () => {
  const job = { id: 'job', human_reference: 'BB-103', project_id: 'project', title: 'Original work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'rename') return { data: { error: 'Job title changed; refresh before saving' }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Original work' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit job name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: 'My unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/changed.*refresh/i);
  expect((screen.getByRole('textbox', { name: 'Job name' }) as HTMLInputElement).value).toBe('My unsaved name');
  expect(screen.getByRole('heading', { name: 'Original work' })).toBeTruthy();
});

it('does not replace another selected job when a delayed rename finishes', async () => {
  const first = { id: 'first', human_reference: 'BB-103', project_id: 'project', title: 'First work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const second = { ...first, id: 'second', human_reference: 'BB-102', title: 'Second work' };
  let finishRename!: (result: { data: { job: typeof first }; error: null }) => void;
  const pending = new Promise<{ data: { job: typeof first }; error: null }>(resolve => { finishRename = resolve; });
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [first, second], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: body.job_id === first.id ? first : second, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'rename') return pending;
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'First work' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit job name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: 'Renamed first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  fireEvent.click(screen.getByRole('button', { name: /BB-102.*Second work/ }));
  await screen.findByRole('heading', { name: 'Second work' });
  await act(async () => finishRename({ data: { job: { ...first, title: 'Renamed first' } }, error: null }));
  expect(screen.getByRole('heading', { name: 'Second work' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /BB-103.*Renamed first/ })).toBeTruthy();
});

it('keeps a saved name when an older queue refresh completes afterward', async () => {
  const job = { id: 'job', human_reference: 'BB-103', project_id: 'project', title: 'Original work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  let finishRefresh!: (result: { data: { jobs: typeof job[]; projects: never[] }; error: null }) => void;
  const refresh = new Promise<{ data: { jobs: typeof job[]; projects: never[] }; error: null }>(resolve => { finishRefresh = resolve; });
  let listCalls = 0;
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return ++listCalls === 1 ? { data: { jobs: [job], projects: [] }, error: null } : refresh;
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'rename') return { data: { job: { ...job, title: 'Renamed work' } }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Original work' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit job name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: 'Renamed work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await screen.findByText(/Name saved for BB-103/i);
  await act(async () => finishRefresh({ data: { jobs: [job], projects: [] }, error: null }));
  expect(screen.getByRole('heading', { name: 'Renamed work' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /BB-103.*Renamed work/ })).toBeTruthy();
});

it.each([
  { action: 'search_names', query: 'work', button: 'Search all job names' },
  { action: 'lookup_reference', query: 'BB-103', button: 'Find reference in all jobs' },
])('keeps a saved name when an older $action result completes afterward', async ({ action, query, button }) => {
  const job = { id: 'job', human_reference: 'BB-103', project_id: 'project', title: 'Original work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  let finishSearch!: (result: { data: { jobs: typeof job[]; job: typeof job }; error: null }) => void;
  const search = new Promise<{ data: { jobs: typeof job[]; job: typeof job }; error: null }>(resolve => { finishSearch = resolve; });
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === action) return search;
    if (body.action === 'rename') return { data: { job: { ...job, title: 'Renamed work' } }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Original work' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit job name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: 'Renamed work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await screen.findByText(/Name saved for BB-103/i);
  await act(async () => finishSearch({ data: { jobs: [job], job }, error: null }));
  expect(screen.getByRole('button', { name: /BB-103.*Renamed work/ })).toBeTruthy();
});

it.each([false, true])('shows the real reference in the create receipt (duplicate: %s)', async duplicate => {
  const job = { id: 'job', human_reference: 'BB-104', project_id: 'project', title: 'Meaningful work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const project = { id: 'project', organization_id: 'org', name: 'FCM', gitea_owner: 'owner', gitea_repo: 'repo' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [project] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'create') return { data: { job, duplicate, autopilot: false }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Meaningful work' });
  fireEvent.click(screen.getByRole('button', { name: 'New job' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Meaningful work' } });
  fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'Describe the work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
  expect(await screen.findByText(duplicate ? /Existing.*BB-104.*no duplicate/i : /created.*BB-104/i)).toBeTruthy();
});

it('shows the new follow-up reference in its receipt', async () => {
  const job = { id: 'job', human_reference: 'BB-104', project_id: 'project', title: 'Original work',
    status: 'failed', target_sha: 'a'.repeat(40), workspace_branch: 'bob/work',
    frontend_required: true, backend_required: false, code_review_mode: 'human',
    created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const followup = { ...job, id: 'followup', human_reference: 'BB-105', title: 'Follow-up: Original work' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job, followup], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: body.job_id === followup.id ? followup : job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    if (body.action === 'create_followup') return { data: { job: followup, autopilot: false }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Original work' });
  fireEvent.change(screen.getByLabelText('Continue on this branch'), { target: { value: 'Finish the remaining work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue build' }));
  expect(await screen.findByText(/follow-up.*BB-105/i)).toBeTruthy();
});

it('loads older Builder jobs and keeps the selected older job when refreshing', async () => {
  const newest = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const older = { ...newest, id: 'older', human_reference: 'BB-1', title: 'Older work', created_at: '2026-11-01T00:00:00Z' };
  const cursor = { created_at: newest.created_at, id: '11111111-1111-4111-8111-111111111111' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: body.cursor
      ? { jobs: [older], projects: [], next_cursor: null }
      : { jobs: [newest], projects: [], next_cursor: cursor }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: body.job_id === older.id ? older : newest, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older jobs' }));
  fireEvent.click(await screen.findByRole('button', { name: /BB-1.*Older work/ }));
  await screen.findByRole('heading', { name: 'Older work' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Older work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /BB-1.*Older work/ })).toBeTruthy();
  });
  expect(invoke.mock.calls.filter(([, { body }]) => body.action === 'list' && body.cursor)).toHaveLength(2);
});

it('finds an accessible old Builder reference without loading every page', async () => {
  const newest = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const older = { ...newest, id: 'older', human_reference: 'BB-1', title: 'Older work' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [newest], projects: [], next_cursor: { created_at: newest.created_at, id: '11111111-1111-4111-8111-111111111111' } }, error: null };
    if (body.action === 'lookup_reference') return { data: { job: body.reference.toUpperCase() === 'BB-1' ? older : null }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: body.job_id === older.id ? older : newest, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Recent work' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: 'bb-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find reference in all jobs' }));
  fireEvent.click(await screen.findByRole('button', { name: /BB-1.*Older work/ }));
  expect(await screen.findByRole('heading', { name: 'Older work' })).toBeTruthy();
  expect(invoke.mock.calls.filter(([, { body }]) => body.action === 'list' && body.cursor)).toHaveLength(0);
});

it('searches older Builder names and pages through additional name matches', async () => {
  const newest = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const older = { ...newest, id: 'older', human_reference: 'BB-3', title: 'Incident at gate' };
  const oldest = { ...newest, id: 'oldest', human_reference: 'BB-1', title: 'Incident report' };
  const cursor = { created_at: newest.created_at, id: '11111111-1111-4111-8111-111111111111' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [newest], projects: [], next_cursor: cursor }, error: null };
    if (body.action === 'search_names') return { data: body.cursor
      ? { jobs: [oldest], next_cursor: null }
      : { jobs: [older], next_cursor: cursor }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: newest, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Recent work' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: 'incident' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all job names' }));
  expect(await screen.findByRole('button', { name: /BB-3.*Incident at gate/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more name matches' }));
  expect(await screen.findByRole('button', { name: /BB-1.*Incident report/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more name matches' })).toBeNull();
  expect(invoke.mock.calls.filter(([, { body }]) => body.action === 'list' && body.cursor)).toHaveLength(0);
});

it('explains that remote name results need a new search after refreshing the queue', async () => {
  const newest = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const match = { ...newest, id: 'older', human_reference: 'BB-3', title: 'Incident at gate' };
  const cursor = { created_at: newest.created_at, id: '11111111-1111-4111-8111-111111111111' };
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [newest], projects: [], next_cursor: cursor }, error: null };
    if (body.action === 'search_names') return { data: { jobs: [match], next_cursor: cursor }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: newest, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Recent work' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: 'incident' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all job names' }));
  await screen.findByRole('button', { name: 'Load more name matches' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText(/Search result pages were reset by refresh/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more name matches' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Search all job names' })).toBeTruthy();
});

it('retains loaded Builder jobs and allows retry after an older page fails', async () => {
  const newest = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  const older = { ...newest, id: 'older', human_reference: 'BB-1', title: 'Older work' };
  let olderRequests = 0;
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list' && !body.cursor) return { data: { jobs: [newest], projects: [], next_cursor: { created_at: newest.created_at, id: '11111111-1111-4111-8111-111111111111' } }, error: null };
    if (body.action === 'list') return ++olderRequests === 1
      ? { data: null, error: { message: 'Older page unavailable' } }
      : { data: { jobs: [older], projects: [], next_cursor: null }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job: newest, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older jobs' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Older page unavailable/);
  expect(screen.getByRole('button', { name: /BB-105.*Recent work/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load older jobs' }));
  expect(await screen.findByRole('button', { name: /BB-1.*Older work/ })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not show a stale reference lookup failure after the filter is cleared', async () => {
  const job = { id: 'newest', human_reference: 'BB-105', project_id: 'project', title: 'Recent work',
    status: 'failed', target_sha: 'a'.repeat(40), created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' };
  let finishLookup: ((value: { data: null; error: { message: string } }) => void) | undefined;
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [], next_cursor: null }, error: null };
    if (body.action === 'lookup_reference') return new Promise(resolve => { finishLookup = resolve; });
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  render(<BuilderControlRoomPage />);
  await screen.findByRole('heading', { name: 'Recent work' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter jobs' }), { target: { value: 'BB-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find reference in all jobs' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  await act(async () => { finishLookup?.({ data: null, error: { message: 'Lookup unavailable' } }); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: /BB-105.*Recent work/ })).toBeTruthy();
});

function retryFixture(backendRequired = true) {
  const updatedAt = '2026-10-27T11:19:32.127197+13:00';
  const job = {
    id: 'failed-job', project_id: 'project', title: 'Verifier recovery',
    status: 'failed', target_sha: 'a'.repeat(40), updated_at: updatedAt,
    autopilot_requested_by: 'owner', autopilot_state: 'blocked',
    frontend_required: true, backend_required: backendRequired, code_review_mode: 'human',
    workspace_published_at: null, workspace_published_head_sha: null,
    workspace_pull_request_url: null, workspace_pull_request_head_sha: null,
  };
  const step = (id: string, step_id: string, status: string, builder_mode: string, extra = {}) => ({
    id, job_id: job.id, step_id, status, builder_mode, ordinal_position: 1,
    attempt_count: step_id === 'frontend_implementation' ? 1 : 0,
    retryable: false, started_at: null, completed_at: null, result_summary: null, error: null, ...extra,
  });
  const steps = [
    step('analysis', 'product_analysis', 'completed', 'product_analyst'),
    step('design', 'ui_design', 'completed', 'ux_designer'),
    step('frontend-step', 'frontend_implementation', 'failed', 'frontend_engineer', {
      error: 'Verifier recovery paused after two infrastructure or attribution failures; patch preserved; inspect the runner and evidence before resuming',
      input_context: { target_sha: job.target_sha, patch_artifact_id: 'saved-patch' },
    }),
    step('backend-step', 'backend_implementation', backendRequired ? 'pending' : 'skipped', 'backend_engineer'),
    ...['test_suite', 'security_review', 'code_review', 'release_prep'].map(id => step(id, id, 'pending', 'qa_security_reviewer')),
  ];
  return {
    job, steps, updatedAt,
    snapshot: {
      job, steps,
      artifacts: [{ id: 'saved-patch', step_id: 'frontend-step', artifact_type: 'code_implementation', status: 'final', checksum: 'b'.repeat(64), content_size_bytes: 24231 }],
      workerRuns: [{ id: 'failed-run', step_id: 'frontend-step', profile: 'frontend-verify', status: 'failed',
        target_sha: job.target_sha, patch_artifact_id: 'saved-patch', exit_code: 1 }],
      approvals: [],
    },
  };
}

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

it('requires a separate owner confirmation before retrying the exact saved frontend patch', async () => {
  const { job, steps, snapshot, updatedAt } = retryFixture();
  expect(failedFrontendPatchRetryCandidate({
    ...snapshot,
    steps: steps.filter(item => item.step_id !== 'backend_implementation'),
  } as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0], 'owner')).toBeNull();
  expect(failedFrontendPatchRetryCandidate({
    ...snapshot,
    job: { ...job, backend_required: false },
    steps: steps.map(item => item.step_id === 'backend_implementation'
      ? { ...item, status: 'skipped', completed_at: '2026-10-27T12:00:00Z' } : item),
  } as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0], 'owner')).not.toBeNull();
  expect(failedFrontendPatchRetryCandidate({
    ...snapshot, workerRuns: [{ ...snapshot.workerRuns[0], status: 'timeout', exit_code: null }],
  } as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0], 'owner')).not.toBeNull();
  expect(failedFrontendPatchRetryCandidate(snapshot as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0], 'other-user')).toBeNull();
  expect(failedFrontendPatchRetryCandidate({
    ...snapshot, workerRuns: [{ ...snapshot.workerRuns[0], status: 'failed', exit_code: null }],
  } as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0], 'owner')).toBeNull();
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: snapshot, error: null };
    if (body.action === 'run') return { data: { accepted: true, already_running: false }, error: null };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  rpc.mockResolvedValue({ data: 'handoff-receipt', error: null });
  render(<BuilderControlRoomPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Review same-job retry' }));
  expect(screen.getByText(/does not rewrite or approve the patch/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm handoff and retry verification' }));

  await screen.findByText(/Saved-patch handoff recorded \(handoff-receipt\)/);
  expect(rpc).toHaveBeenCalledWith('builder_retry_failed_frontend_patch', {
    p_job_id: job.id,
    p_step_id: 'frontend-step',
    p_patch_artifact_id: 'saved-patch',
    p_target_sha: job.target_sha,
    p_job_updated_at: updatedAt,
  });
  expect(invoke.mock.calls.some(([, { body }]) => body.action === 'run' && body.job_id === job.id)).toBe(true);
});

it.each(['handoff', 'run'])('keeps the %s error visible after successful refresh', async failurePoint => {
  const { job, snapshot } = retryFixture();
  invoke.mockImplementation(async (_name, { body }) => {
    if (body.action === 'list') return { data: { jobs: [job], projects: [] }, error: null };
    if (body.action === 'context_snapshot') return { data: {}, error: null };
    if (body.action === 'get') return { data: snapshot, error: null };
    if (body.action === 'run' && failurePoint === 'run') return { data: null, error: { message: 'runner unavailable' } };
    throw new Error(`Unexpected action: ${body.action}`);
  });
  if (failurePoint === 'handoff') rpc.mockResolvedValue({ data: null, error: { message: 'saved-patch state changed' } });
  else rpc.mockResolvedValue({ data: 'handoff-receipt', error: null });
  render(<BuilderControlRoomPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review same-job retry' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm handoff and retry verification' }));
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toMatch(failurePoint === 'handoff' ? /saved-patch state changed/ : /runner unavailable/);
  });
  if (failurePoint === 'run') {
    expect(screen.getByText(/Bob could not start \(.*runner unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Bob remains queued/)).toBeNull();
  }
});
