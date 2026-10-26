import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BuilderChatPanel, chatContext, groupChat, mergeSnapshot, type BuilderChatMessage } from './BuilderChatPanel';

const { rpc, from, channel, removeChannel, getUser } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(), getUser: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from, channel, removeChannel, auth: { getUser } } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const THREAD = '6f1d2c3b-0000-4000-8000-000000000001';
const row = (id: string, seq: number, role: BuilderChatMessage['role'], kind: BuilderChatMessage['kind'], content = id, payload: Record<string, unknown> = {}): BuilderChatMessage => ({
  id, seq, thread_id: THREAD, role, kind, content, payload, status: 'done', created_at: new Date(0).toISOString(),
});
const PROPOSAL = { title: 'CCTV tokens', task_description: 'Move CctvReviewPage.css onto shared tokens.', frontend_required: true, backend_required: false, rationale: 'Matches Dispatch.' };

function wire({ owner = true, threads = [{ id: THREAD }], messages = [] as BuilderChatMessage[], reserve = true } = {}) {
  const query = (rows: unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const name of ['select', 'neq', 'eq', 'order']) builder[name] = () => builder;
    builder.limit = async () => ({ data: rows, error: null });
    return builder;
  };
  from.mockImplementation((table: string) => query(table === 'builder_chat_threads' ? threads : messages));
  const sub = { on: vi.fn(() => sub), subscribe: () => sub };
  channel.mockReturnValue(sub);
  getUser.mockResolvedValue({ data: { user: { id: 'test-owner' } }, error: null });
  rpc.mockImplementation(async (name: string) => {
    if (name === 'is_grand_master') return { data: owner, error: null };
    if (name === 'builder_chat_thread_open') return { data: THREAD, error: null };
    if (name === 'builder_chat_reserve_proposal') return { data: reserve, error: null };
    return { data: null, error: null };
  });
}

it('keeps only short scalar page context and groups tool steps', () => {
  expect(chatContext({ job_id: 'j', count: 2, ok: true, none: null, nested: { a: 1 }, long: 'x'.repeat(500) })).toEqual({ job_id: 'j', count: 2, ok: true, none: null, long: 'x'.repeat(300) });
  const grouped = groupChat([row('a', 1, 'owner', 'message'), row('t', 2, 'bob', 'thinking'), row('s1', 3, 'tool', 'tool'), row('s2', 4, 'tool', 'tool'), row('b', 5, 'bob', 'message')]);
  expect(grouped.map(item => item.type)).toEqual(['message', 'steps', 'message']);
});

it('tells a non-owner the Builder chat is restricted', async () => {
  wire({ owner: false });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} />);
  expect(await screen.findByText(/limited to the platform owner/)).toBeTruthy();
  expect(screen.getByText('Build lane chat · separate from in-app Bob')).toBeTruthy();
});

it('defaults to one cloud PM packet, requiring approval and withholding private selected-job context', async () => {
  wire();
  render(<BuilderChatPanel context={{ surface: 'builder_control_room', job_title: 'Dispatch tokens', nested: { no: 1 } }} onCreateJob={vi.fn()} />);
  expect(await screen.findByText(/Bob is your technical PM and QA lead/)).toBeTruthy();
  expect(screen.getByText('Dispatch tokens')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Message Bob Builder'), { target: { value: 'What is waiting on me?' } });
  const send = screen.getByRole('button', { name: 'Send approved PM message' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I reviewed this question/));
  fireEvent.click(send);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_chat_send_pm', {
    p_thread_id: THREAD, p_content: 'What is waiting on me?', p_client_request_id: expect.any(String),
    p_purpose: 'pm', p_evidence_summary: '', p_files: [], p_urls: [], p_web_search: false, p_allow_cloud: true,
  }));
  expect(rpc.mock.calls.map(call => call[0])).not.toContain('builder_chat_send');
  expect(rpc.mock.calls.map(call => call[0])).not.toContain('onspace-ai-chat');
});

it('creates a proposed job only when the owner confirms, then records it on the proposal', async () => {
  wire({ messages: [row('o', 1, 'owner', 'message', 'Queue CCTV'), row('p', 2, 'bob', 'proposal', 'CCTV tokens', { proposal: PROPOSAL })] });
  const onCreateJob = vi.fn(async () => 'job-123');
  render(<BuilderChatPanel context={{}} onCreateJob={onCreateJob} jobSettings="FCM · main · development · human review" />);
  expect(await screen.findByRole('article', { name: 'Proposed Builder job: CCTV tokens' })).toBeTruthy();
  expect(screen.getByText(/Creates with: FCM · main · development · human review\. Nothing runs until you create it\./)).toBeTruthy();
  expect(onCreateJob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_chat_record_job', { p_message_id: 'p', p_job_id: 'job-123' }));
  expect(onCreateJob).toHaveBeenCalledWith(PROPOSAL);
  const names = rpc.mock.calls.map(call => call[0]);
  expect(names.indexOf('builder_chat_reserve_proposal')).toBeLessThan(names.indexOf('builder_chat_record_job'));
});

it('does not create a job when another tab already holds the proposal', async () => {
  wire({ reserve: false, messages: [row('p', 2, 'bob', 'proposal', 'CCTV tokens', { proposal: PROPOSAL })] });
  const onCreateJob = vi.fn(async () => 'job-123');
  render(<BuilderChatPanel context={{}} onCreateJob={onCreateJob} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create job' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/already being created from another tab/);
  expect(onCreateJob).not.toHaveBeenCalled();
});

it('shows a proposal reserved by another tab as creating, not clickable', async () => {
  wire({ messages: [row('p', 2, 'bob', 'proposal', 'CCTV tokens', { proposal: PROPOSAL, creating_token: 'other-tab-token', creating_at: new Date().toISOString() })] });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} />);
  const button = await screen.findByRole('button', { name: /Creating/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});

it('keeps live rows that arrived during a snapshot fetch and adds missed ones', () => {
  const queued = { ...row('o', 1, 'owner', 'message'), status: 'queued' as const };
  const liveDone = { ...queued, status: 'done' as const };
  const merged = mergeSnapshot([liveDone], [queued, row('b', 2, 'bob', 'message', 'answer')], new Set(['o']));
  expect(merged.map(message => [message.id, message.status])).toEqual([['o', 'done'], ['b', 'done']]);
  expect(mergeSnapshot([queued], [liveDone], new Set()).map(message => message.status)).toEqual(['done']);
});

it('shows an accepted proposal as created with a way to open the job', async () => {
  wire({ messages: [row('p', 2, 'bob', 'proposal', 'CCTV tokens', { proposal: PROPOSAL, job_id: 'job-9' })] });
  const onOpenJob = vi.fn();
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} onOpenJob={onOpenJob} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open job' }));
  expect(onOpenJob).toHaveBeenCalledWith('job-9');
  expect(screen.queryByRole('button', { name: 'Create job' })).toBeNull();
  expect(screen.getByText('Receipt: job-9')).toBeTruthy();
});

it('labels a PM investigation distinctly and retains the same confirmation and receipt path', async () => {
  const proposal = { ...PROPOSAL, handoff_kind: 'investigation', source_message_id: 'owner-report' };
  wire({ messages: [row('p', 2, 'bob', 'proposal', 'Investigate report', { proposal })] });
  const onCreateJob = vi.fn(async () => 'investigation-job');
  render(<BuilderChatPanel context={{}} onCreateJob={onCreateJob} />);
  expect(await screen.findByText(/Investigation handoff · Bob Builder/)).toBeTruthy();
  expect(screen.getByText(/Reported issue, not a verified repair plan/)).toBeTruthy();
  expect(onCreateJob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_chat_record_job', { p_message_id: 'p', p_job_id: 'investigation-job' }));
  expect(onCreateJob).toHaveBeenCalledWith(proposal);
});

it('surfaces a failed job creation instead of marking the proposal accepted', async () => {
  wire({ messages: [row('p', 2, 'bob', 'proposal', 'CCTV tokens', { proposal: PROPOSAL })] });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn(async () => { throw new Error('Choose a Builder project before creating a job.'); })} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create job' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose a Builder project before creating a job.');
  expect(rpc.mock.calls.map(call => call[0])).not.toContain('builder_chat_record_job');
  expect(rpc).toHaveBeenCalledWith('builder_chat_release_proposal', expect.objectContaining({ p_message_id: 'p' }));
});

it('confirms an existing-job revision separately from job creation and shows its real receipt', async () => {
  wire({ messages: [row('review', 1, 'owner', 'message'), row('revision-card', 2, 'bob', 'proposal', 'Revision', {
    message_id: 'review',
    revision: { job_id: 'existing-job', feedback: 'Verify the current workflow before approving implementation.' },
  })] });
  const prior = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name: string, args: unknown) => name === 'builder_chat_request_spec_revision'
    ? { data: 'audit-receipt', error: null } : prior(name, args));
  const create = vi.fn();
  render(<BuilderChatPanel context={{}} onCreateJob={create} />);
  const confirm = await screen.findByRole('button', { name: 'Request specification revision' });
  expect(rpc.mock.calls.some(call => call[0] === 'builder_chat_request_spec_revision')).toBe(false);
  fireEvent.click(confirm);
  expect(await screen.findByText('Revision requested · Receipt: audit-receipt')).toBeTruthy();
  expect(rpc).toHaveBeenCalledWith('builder_chat_request_spec_revision', { p_message_id: 'revision-card' });
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Request specification revision' })).toBeNull();
});

it('shows a moved-gate error without claiming a revision was sent or creating a job', async () => {
  wire({ messages: [row('review', 1, 'owner', 'message'), row('revision-card', 2, 'bob', 'proposal', 'Revision', {
    message_id: 'review',
    revision: { job_id: 'existing-job', feedback: 'Revisit the report before implementation.' },
  })] });
  const prior = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name: string, args: unknown) => name === 'builder_chat_request_spec_revision'
    ? { data: null, error: { message: 'Specification review has moved; prepare a fresh revision' } } : prior(name, args));
  const create = vi.fn();
  render(<BuilderChatPanel context={{}} onCreateJob={create} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Request specification revision' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/has moved/);
  expect(screen.queryByText(/Revision requested · Receipt/)).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it('waits for the source turn to complete when its revision card arrives first', async () => {
  const review = { ...row('review', 1, 'owner', 'message'), status: 'claimed' as const };
  wire({ messages: [review, row('revision-card', 2, 'bob', 'proposal', 'Revision', {
    message_id: review.id, revision: { job_id: 'existing-job', feedback: 'Verify the reported workflow before implementation.' },
  })] });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} />);
  const confirm = await screen.findByRole('button', { name: 'Request specification revision' });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Waiting for the originating PM turn/)).toBeTruthy();
  fireEvent.click(confirm);
  expect(rpc.mock.calls.some(call => call[0] === 'builder_chat_request_spec_revision')).toBe(false);
  const onChange = channel.mock.results[0].value.on.mock.calls[0][2];
  act(() => onChange({ new: { ...review, status: 'done' } }));
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/Waiting for the originating PM turn/)).toBeNull();
});

it('keeps confirmation disabled with a safe next action if the source turn failed', async () => {
  wire({ messages: [{ ...row('review', 1, 'owner', 'message'), status: 'failed' },
    row('revision-card', 2, 'bob', 'proposal', 'Revision', {
      message_id: 'review', revision: { job_id: 'existing-job', feedback: 'Verify the reported workflow before implementation.' },
    })] });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} />);
  expect((await screen.findByRole('button', { name: 'Request specification revision' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Ask Bob for a fresh revision card/)).toBeTruthy();
});

it('delivers implementation feedback to the same job only after confirmation, with no creation or specification rewind', async () => {
  const messages = [row('review', 1, 'owner', 'message'), row('changes', 2, 'bob', 'proposal', 'Corrections', {
    message_id: 'review', revision: { kind: 'implementation', job_id: 'existing-job', feedback: 'Verify the real receipt reader and retry behavior before seeking fresh human review.' },
  })];
  wire({ messages });
  const onCreateJob = vi.fn();
  rpc.mockImplementation(async name => ({ data: name === 'is_grand_master' ? true : name === 'builder_chat_request_code_changes' ? 'audit-receipt' : null, error: null }));
  render(<BuilderChatPanel context={{}} onCreateJob={onCreateJob} />);
  expect(await screen.findByRole('article', { name: 'Implementation corrections for job existing-job' })).toBeTruthy();
  expect(screen.getByText(/verification and security run again/i)).toBeTruthy();
  expect(rpc.mock.calls.some(call => call[0] === 'builder_chat_request_code_changes')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Request implementation changes' }));
  expect(await screen.findByText('Revision requested · Receipt: audit-receipt')).toBeTruthy();
  expect(rpc).toHaveBeenCalledWith('builder_chat_request_code_changes', { p_message_id: 'changes' });
  expect(rpc.mock.calls.some(call => call[0] === 'builder_chat_request_spec_revision')).toBe(false);
  expect(onCreateJob).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Request implementation changes' })).toBeNull();
});

it('surfaces a stale implementation gate and never manufactures a receipt', async () => {
  wire({ messages: [row('review', 1, 'owner', 'message'), row('changes', 2, 'bob', 'proposal', 'Corrections', {
    message_id: 'review', revision: { kind: 'implementation', job_id: 'existing-job', feedback: 'Verify the real receipt reader before fresh human review.' },
  })] });
  rpc.mockImplementation(async name => name === 'builder_chat_request_code_changes'
    ? { data: null, error: { message: 'Human code review has moved or expired; prepare a fresh correction card' } }
    : { data: true, error: null });
  render(<BuilderChatPanel context={{}} onCreateJob={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Request implementation changes' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/moved or expired/);
  expect(screen.queryByText(/Revision requested · Receipt/)).toBeNull();
});
