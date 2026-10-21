import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import BuilderVibePage, { groupThread, type VibeMessage } from './BuilderVibePage';

const { rpc, from, channel, removeChannel, storageFrom, functionsInvoke } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  storageFrom: vi.fn(),
  functionsInvoke: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({
  supabase: { rpc, from, channel, removeChannel, storage: { from: storageFrom }, functions: { invoke: functionsInvoke } },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'owner-id' } }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function query(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'neq', 'eq', 'order']) builder[name] = () => builder;
  builder.limit = async () => ({ data: rows, error: null });
  return builder;
}

function wireRealtime() {
  const sub = { on: () => sub, subscribe: () => sub };
  channel.mockReturnValue(sub);
}

const message = (id: string, seq: number, role: VibeMessage['role'], kind: VibeMessage['kind'], content = id): VibeMessage => ({
  id, seq, session_id: 's', role, kind, content, payload: {}, status: 'done', created_at: new Date(0).toISOString(),
});

it('groups consecutive tool steps between conversational messages and hides thinking', () => {
  const grouped = groupThread([
    message('a', 1, 'owner', 'message'),
    message('t', 2, 'bob', 'thinking'),
    message('b', 3, 'tool', 'tool'),
    message('c', 4, 'tool', 'test'),
    message('d', 5, 'bob', 'message'),
    message('e', 6, 'tool', 'tool'),
  ]);
  expect(grouped.map((item) => item.type === 'steps' ? `steps:${item.steps.map((step) => step.id).join(',')}` : item.message.id))
    .toEqual(['a', 'steps:b,c', 'd', 'steps:e']);
});

it('refuses non-owners and points them at jobs and approvals', async () => {
  rpc.mockResolvedValue({ data: false, error: null });
  const onOpenJobs = vi.fn();
  render(<BuilderVibePage onOpenJobs={onOpenJobs} />);
  fireEvent.click(await screen.findByRole('button', { name: /Jobs & approvals/ }));
  expect(onOpenJobs).toHaveBeenCalled();
  expect(from).not.toHaveBeenCalled();
});

it('shows starters for an owner with no sessions and opens a session from one', async () => {
  wireRealtime();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'is_grand_master') return { data: true, error: null };
    if (name === 'builder_vibe_session_open') return { data: 'new-session', error: null };
    if (name === 'builder_vibe_send') return { data: 'msg', error: null };
    throw new Error(`Unexpected rpc ${name}`);
  });
  from.mockImplementation(() => query([]));
  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Describe it. Bob builds it.' });
  const starter = screen.getAllByRole('button').find((button) => button.className.includes('vibe-chip'));
  expect(starter).toBeTruthy();
  fireEvent.click(starter!);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_vibe_session_open', expect.objectContaining({ p_title: expect.any(String) })));
});

it('uploads a document privately, extracts text, and sends its session-scoped reference', async () => {
  wireRealtime();
  const sessionId = '1a2b3c4d-0000-4000-8000-000000000001';
  rpc.mockImplementation(async (name: string) => {
    if (name === 'is_grand_master') return { data: true, error: null };
    return { data: 'attachment-id', error: null };
  });
  from.mockImplementation((table: string) => query(table === 'builder_vibe_sessions' ? [{
    id: sessionId, title: 'Review error', status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: new Date(0).toISOString(),
  }] : []));
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  storageFrom.mockReturnValue({ upload, remove });
  functionsInvoke.mockResolvedValue({ data: { success: true, text: 'Visible error: employment date is missing', checksum: 'a'.repeat(64), has_text: true }, error: null });

  render(<BuilderVibePage />);
  const input = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  const file = new File(['sample pdf'], 'error.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), { target: { files: [file] } });
  fireEvent.change(input, { target: { value: 'Please investigate this error' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_vibe_send_with_attachments', expect.objectContaining({
    p_session_id: sessionId,
    p_content: 'Please investigate this error',
    p_attachment_ids: [expect.any(String)],
  })));
  expect(upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^desktop/owner-id/vibe/${sessionId}/`)), file, expect.objectContaining({ contentType: 'application/pdf', upsert: false }));
  expect(rpc).toHaveBeenCalledWith('builder_vibe_attachment_register', expect.objectContaining({
    p_session_id: sessionId,
    p_file_name: 'error.pdf',
    p_file_type: 'application/pdf',
    p_file_size_bytes: file.size,
  }));
  expect(functionsInvoke).toHaveBeenCalledWith('bob-extract-document', expect.objectContaining({
    body: expect.objectContaining({ file_name: 'error.pdf', storage_bucket: 'bob-uploads' }),
  }));
  expect(rpc).toHaveBeenCalledWith('builder_vibe_attachment_set_extraction', expect.objectContaining({
    p_extraction_status: 'extracted',
    p_sha256: 'a'.repeat(64),
    p_extracted_text: 'Visible error: employment date is missing',
  }));
  expect(functionsInvoke).not.toHaveBeenCalledWith('bob-document-register', expect.anything());
});

it('distinguishes completed attachment analysis from a failed coding turn', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const failed = {
    ...message('failed', 1, 'owner', 'message', 'Fix profile navigation'),
    session_id: 's',
    status: 'failed' as const,
    payload: { attachment_context: [{ file_name: 'screen.png', context: 'A 404 is visible.' }] },
  };
  from.mockImplementation((table: string) => query(table === 'builder_vibe_sessions' ? [{
    id: 's', title: 'Navigation', status: 'open', changed_files: [], preview_status: 'off',
  }] : [failed]));
  render(<BuilderVibePage />);
  await screen.findByText(/Coding turn stopped after attachment analysis/);
  expect(screen.getByText('A 404 is visible.')).toBeTruthy();
  expect(screen.queryByText('Not processed — send it again')).toBeNull();
});
