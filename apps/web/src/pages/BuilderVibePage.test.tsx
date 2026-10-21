import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import BuilderVibePage, { groupThread, type VibeMessage } from './BuilderVibePage';

const { rpc, from, channel, removeChannel } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from, channel, removeChannel } }));
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
