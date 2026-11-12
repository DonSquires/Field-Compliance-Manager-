import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const fixtureReferences = new Map<string, string>();
afterEach(() => { cleanup(); vi.resetAllMocks(); fixtureReferences.clear(); });

function query(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'neq', 'eq', 'order']) builder[name] = () => builder;
  builder.limit = async () => ({ data: rows, error: null });
  return builder;
}

function wireRealtime() {
  const sub = { on: () => sub, subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; } };
  channel.mockReturnValue(sub);
}

type QueryResult = { data: Array<Record<string, unknown>> | null; error: { message: string } | null };

function pagedQuery(rows: Array<Record<string, unknown>>) {
  let filtered = rows.slice();
  const ordering: Array<{ field: string; ascending: boolean }> = [];
  const builder = {
    select: () => builder,
    neq: (field: string, value: unknown) => { filtered = filtered.filter((row) => row[field] !== value); return builder; },
    eq: (field: string, value: unknown) => { filtered = filtered.filter((row) => row[field] === value); return builder; },
    in: (field: string, values: unknown[]) => { filtered = filtered.filter((row) => values.includes(row[field])); return builder; },
    lt: (field: string, value: number) => { filtered = filtered.filter((row) => Number(row[field]) < value); return builder; },
    lte: (field: string, value: number) => { filtered = filtered.filter((row) => Number(row[field]) <= value); return builder; },
    gt: (field: string, value: number) => { filtered = filtered.filter((row) => Number(row[field]) > value); return builder; },
    gte: (field: string, value: number) => { filtered = filtered.filter((row) => Number(row[field]) >= value); return builder; },
    filter: (field: string, operator: string, value: string) => {
      if (operator !== 'imatch') throw new Error(`Unexpected filter operator: ${operator}`);
      const literal = new RegExp(value, 'i');
      filtered = filtered.filter((row) => literal.test(String(row[field])));
      return builder;
    },
    or: (expression: string) => {
      const match = /^last_activity_at\.lt\.([^,]+),and\(last_activity_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/.exec(expression);
      if (!match || match[1] !== match[2]) throw new Error(`Unexpected cursor: ${expression}`);
      const [, timestamp, , id] = match;
      filtered = filtered.filter((row) => String(row.last_activity_at) < timestamp || (row.last_activity_at === timestamp && String(row.id) < id));
      return builder;
    },
    order: (field: string, options: { ascending: boolean }) => { ordering.push({ field, ascending: options.ascending }); return builder; },
    limit: async (count: number): Promise<QueryResult> => ({
      data: filtered.sort((a, b) => {
        for (const { field, ascending } of ordering) {
          const left = a[field];
          const right = b[field];
          const comparison = typeof left === 'number' && typeof right === 'number'
            ? left - right : String(left).localeCompare(String(right));
          if (comparison) return ascending ? comparison : -comparison;
        }
        return 0;
      }).slice(0, count),
      error: null,
    }),
  };
  return builder;
}

function session(id: string, title: string) {
  if (!fixtureReferences.has(id)) fixtureReferences.set(id, `VB-${fixtureReferences.size + 1}`);
  return {
    id, title, human_reference: fixtureReferences.get(id), status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z',
  };
}

const message = (id: string, seq: number, role: VibeMessage['role'], kind: VibeMessage['kind'], content = id): VibeMessage => ({
  id, seq, session_id: 's', role, kind, content, payload: {}, status: 'done', created_at: new Date(0).toISOString(),
});

it('opens the latest messages and can page back past 600 without losing their order', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = Array.from({ length: 705 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Long session')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('Message 705');
  expect(screen.queryByText('Message 1')).toBeNull();

  for (const first of [506, 406, 306, 206, 106, 6, 1]) {
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText(`Message ${first}`);
  }
  expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  expect(screen.getAllByText('Message 705')).toHaveLength(1);
  expect(screen.getByText('Message 1').compareDocumentPosition(screen.getByText('Message 705')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}, 15000);

it('can browse beyond 50 sessions even when activity timestamps tie', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`, `Session ${String(number).padStart(3, '0')}`);
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 105');
  expect(screen.queryByText('Session 001')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Session 006');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Session 001');
  expect(screen.queryByRole('button', { name: 'Load older sessions' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /Session 105/ })).toHaveLength(1);
});

it('shows the stored Vibe reference in the session list and selected session', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const active = { ...session('s', 'Review roster'), human_reference: 'VB-105' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  expect(await screen.findByRole('button', { name: /VB-105.*Review roster/ })).toBeTruthy();
  expect(screen.getByText('Reference: VB-105')).toBeTruthy();
});

it('links a shipped session to the GitHub Actions runs for its own branch', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const prUrl = 'https://github.com/DonSquires/Field-Compliance-Manager-/pull/421';
  const active = { ...session('s', 'Shipped session'), branch: 'bob/vibe-8effb979', pr_url: prUrl };
  const shipped = { ...message('m1', 1, 'bob', 'message', 'Opened the pull request'), payload: { pr_url: prUrl } };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : [shipped]));

  render(<BuilderVibePage />);
  await screen.findByText('Opened the pull request');
  const actions = 'https://github.com/DonSquires/Field-Compliance-Manager-/actions?query=branch%3Abob%2Fvibe-8effb979';
  expect(screen.getByRole('link', { name: 'Checks' }).getAttribute('href')).toBe(actions);
  expect(screen.getByRole('link', { name: 'GitHub Actions checks' }).getAttribute('href')).toBe(actions);
});

it('saves an edited Vibe session name without changing its reference', async () => {
  wireRealtime();
  const active = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  rpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
    if (name === 'builder_vibe_rename_session') {
      expect(args).toEqual({ p_session_id: 's', p_expected_title: 'Original session', p_title: 'Clear session' });
      return { single: async () => ({ data: { ...active, title: 'Clear session' }, error: null }) };
    }
    return Promise.resolve({ data: true, error: null });
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: '  Clear session  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  expect(await screen.findByRole('heading', { name: 'Clear session' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /VB-105.*Clear session/ })).toBeTruthy();
  expect(screen.getByText('Reference: VB-105')).toBeTruthy();
});

it('keeps the Vibe name draft when a rename is rejected', async () => {
  wireRealtime();
  const active = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  rpc.mockImplementation((name: string) => name === 'builder_vibe_rename_session'
    ? { single: async () => ({ data: null, error: { message: 'Session title changed; refresh before saving' } }) }
    : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  await screen.findByText(/title changed; refresh/i);
  expect((screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement).value).toBe('Unsaved name');
  expect(screen.getByRole('heading', { name: 'Original session' })).toBeTruthy();
});

it('keeps the Vibe name draft when the rename receipt has no valid update timestamp', async () => {
  wireRealtime();
  const active = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  rpc.mockImplementation((name: string) => name === 'builder_vibe_rename_session'
    ? { single: async () => ({ data: { ...active, title: 'Unsaved name', updated_at: 'invalid' }, error: null }) }
    : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  expect(await screen.findByText(/saved session name and reference could not be confirmed/i)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement).value).toBe('Unsaved name');
  expect(screen.getByRole('heading', { name: 'Original session' })).toBeTruthy();
});

it('keeps a saved Vibe name when an older session-list refresh finishes afterward', async () => {
  let onSession: ((change: { new: Record<string, unknown>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: Record<string, unknown>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  const active = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  let finishRefresh!: (result: QueryResult) => void;
  const refresh = new Promise<QueryResult>(resolve => { finishRefresh = resolve; });
  let delayRefresh = false;
  let refreshStarted = false;
  rpc.mockImplementation((name: string) => name === 'builder_vibe_rename_session'
    ? { single: async () => ({ data: { ...active, title: 'Clear session' }, error: null }) }
    : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [active] : []);
    const limit = result.limit;
    result.limit = (count) => {
      if (table === 'builder_vibe_sessions' && delayRefresh && !refreshStarted) {
        refreshStarted = true;
        return refresh;
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  delayRefresh = true;
  act(() => onSession?.({ eventType: 'UPDATE', new: active }));
  await waitFor(() => expect(refreshStarted).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Clear session' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  await screen.findByText('Name saved for VB-105.');
  await act(async () => finishRefresh({ data: [active], error: null }));
  expect(screen.getByRole('heading', { name: 'Clear session' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /VB-105.*Clear session/ })).toBeTruthy();
});

it('does not replace a saved Vibe name with a delayed realtime event while refreshing', async () => {
  let onSession: ((change: { new: Record<string, unknown>; eventType: string; commit_timestamp: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: Record<string, unknown>; eventType: string; commit_timestamp: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  const original = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  const saved = { ...original, title: 'Clear session', updated_at: '2026-11-10T00:00:02.000500+00:00' };
  let finishRefresh!: (result: QueryResult) => void;
  const refresh = new Promise<QueryResult>(resolve => { finishRefresh = resolve; });
  let delayRefresh = false;
  rpc.mockImplementation((name: string) => name === 'builder_vibe_rename_session'
    ? { single: async () => ({ data: saved, error: null }) }
    : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [saved] : []);
    const limit = result.limit;
    result.limit = (count) => table === 'builder_vibe_sessions' && delayRefresh ? refresh : limit(count);
    return result;
  });
  from.mockImplementationOnce((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [original] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Clear session' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  await screen.findByText('Name saved for VB-105.');
  delayRefresh = true;
  act(() => onSession?.({ eventType: 'UPDATE', new: original, commit_timestamp: '2026-11-10T00:00:02.000499Z' }));
  expect(screen.getByRole('heading', { name: 'Clear session' })).toBeTruthy();
  await act(async () => finishRefresh({ data: [saved], error: null }));
  expect(screen.getByRole('heading', { name: 'Clear session' })).toBeTruthy();
});

it('accepts a newer realtime session name after a local rename', async () => {
  let onSession: ((change: { new: Record<string, unknown>; eventType: string; commit_timestamp: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: Record<string, unknown>; eventType: string; commit_timestamp: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  const original = { ...session('s', 'Original session'), created_by: 'owner-id', human_reference: 'VB-105' };
  const saved = { ...original, title: 'Clear session', updated_at: '2026-11-10T00:00:02.000500+00:00' };
  const newer = { ...saved, title: 'Updated elsewhere', updated_at: '2026-11-10T00:00:02.000501+00:00' };
  let current = original;
  rpc.mockImplementation((name: string) => name === 'builder_vibe_rename_session'
    ? { single: async () => { current = saved; return { data: saved, error: null }; } }
    : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [current] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Original session' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit session name' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Clear session' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save session name' }));
  await screen.findByText('Name saved for VB-105.');
  current = newer;
  act(() => onSession?.({ eventType: 'UPDATE', new: newer, commit_timestamp: '2026-11-10T00:00:02.000501Z' }));
  expect(screen.getByRole('heading', { name: 'Updated elsewhere' })).toBeTruthy();
});

it('finds an older Vibe session by its exact reference without loading every page', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return { ...session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
      `Session ${String(number).padStart(3, '0')}`), human_reference: `VB-${number}` };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findByRole('button', { name: /VB-105.*Session 105/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Search Vibe sessions' }), { target: { value: 'vb-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all Vibe sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /VB-1.*Session 001/ }));
  expect(await screen.findByRole('heading', { name: 'Session 001' })).toBeTruthy();
  expect(screen.getByText('Reference: VB-1')).toBeTruthy();
});

it('finds both reference and title matches for a reference-shaped search', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const rows = [
    { ...session('a', 'Exact reference'), human_reference: 'VB-1' },
    { ...session('b', 'Longer reference'), human_reference: 'VB-105' },
    { ...session('c', 'Investigate VB-1 issue'), human_reference: 'VB-7' },
    { ...session('d', 'Unrelated'), human_reference: 'VB-8' },
  ];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? rows : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search Vibe sessions' }), { target: { value: 'vb-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all Vibe sessions' }));
  const results = await screen.findByRole('region', { name: 'Vibe session search results' });
  expect(within(results).getByRole('button', { name: /VB-1.*Exact reference/ })).toBeTruthy();
  expect(within(results).getByRole('button', { name: /VB-105.*Longer reference/ })).toBeTruthy();
  expect(within(results).getByRole('button', { name: /VB-7.*Investigate VB-1 issue/ })).toBeTruthy();
  expect(within(results).queryByRole('button', { name: /Unrelated/ })).toBeNull();
});

it('finds literal Vibe session names across closed history', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const closed = { ...session('c', 'Inspect 100% [gate]'), status: 'closed', human_reference: 'VB-7' };
  const unrelated = { ...session('a', 'Inspect 100 gate'), human_reference: 'VB-8' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [closed, unrelated] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Inspect 100 gate' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Search Vibe sessions' }), { target: { value: '100% [gate]' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all Vibe sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /VB-7.*Inspect 100% \[gate\]/ }));
  expect(await screen.findByRole('heading', { name: 'Inspect 100% [gate]' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

it('pages through more than 100 matching Vibe sessions with tied timestamps', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return { ...session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
      `Work ${String(number).padStart(3, '0')}`), status: 'closed' };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search Vibe sessions' }), { target: { value: 'Work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all Vibe sessions' }));
  const results = await screen.findByRole('region', { name: 'Vibe session search results' });
  expect(within(results).getByRole('button', { name: /Work 105/ })).toBeTruthy();
  expect(within(results).queryByRole('button', { name: /Work 001/ })).toBeNull();
  fireEvent.click(within(results).getByRole('button', { name: 'Load more matching sessions' }));
  await within(results).findByRole('button', { name: /Work 006/ });
  fireEvent.click(within(results).getByRole('button', { name: 'Load more matching sessions' }));
  expect(await within(results).findByRole('button', { name: /Work 001/ })).toBeTruthy();
  expect(within(results).getAllByRole('button', { name: /Work \d{3}/ })).toHaveLength(105);
  expect(within(results).queryByRole('button', { name: 'Load more matching sessions' })).toBeNull();
});

it('pages and deduplicates Vibe matches found in both names and references', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return {
      ...session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
        `${index % 2 ? 'Work' : 'VB-1 work'} ${String(number).padStart(3, '0')}`),
      human_reference: `VB-${1000 + index}`, status: 'closed',
    };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search Vibe sessions' }), { target: { value: 'VB-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search all Vibe sessions' }));
  const results = await screen.findByRole('region', { name: 'Vibe session search results' });
  expect(within(results).getAllByRole('button', { name: /Work|VB-1 work/i })).toHaveLength(50);
  fireEvent.click(within(results).getByRole('button', { name: 'Load more matching sessions' }));
  await waitFor(() => expect(within(results).getAllByRole('button', { name: /Work|VB-1 work/i })).toHaveLength(100));
  fireEvent.click(within(results).getByRole('button', { name: 'Load more matching sessions' }));
  await waitFor(() => expect(within(results).getAllByRole('button', { name: /Work|VB-1 work/i })).toHaveLength(105));
  expect(within(results).queryByRole('button', { name: 'Load more matching sessions' })).toBeNull();
});

it('opens closed session history without allowing new work in it', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const active = session('a', 'Active work');
  const closed = { ...session('c', 'Closed work'), status: 'closed', changed_files: ['src/example.ts'],
    preview_requested: true, preview_status: 'ready' };
  const closedMessage = { ...message('closed-message', 1, 'owner', 'message', 'Completed request'), session_id: 'c' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active, closed] : [closedMessage]));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Active work' });
  expect(screen.queryByRole('button', { name: /Closed work/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show closed sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /Closed work/ }));
  await screen.findByRole('heading', { name: 'Closed work' });
  await screen.findByText('Completed request');
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Ship as PR' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Show here' })).toBeNull();
  expect(rpc).not.toHaveBeenCalledWith('builder_vibe_send', expect.anything());
});

it('pages through closed session history beyond 100 records', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return { ...session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
      `Closed ${String(number).padStart(3, '0')}`), status: 'closed' };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Show closed sessions' }));
  await screen.findByRole('button', { name: /Closed 105/ });
  expect(screen.queryByRole('button', { name: /Closed 001/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load older closed sessions' }));
  await screen.findByRole('button', { name: /Closed 006/ });
  fireEvent.click(screen.getByRole('button', { name: 'Load older closed sessions' }));
  await screen.findByRole('button', { name: /Closed 001/ });
  expect(screen.queryByRole('button', { name: 'Load older closed sessions' })).toBeNull();
});

it('keeps sessions closed while an older closed-history page is loading', async () => {
  let onSession: ((change: { new: Record<string, unknown>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: Record<string, unknown>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const active = session('s', 'Closing work');
  const previouslyClosed = { ...session('c', 'Earlier work'), status: 'closed' };
  let rows = [active, previouslyClosed];
  let finishClosed!: (value: QueryResult) => void;
  const closedPage = new Promise<QueryResult>(resolve => { finishClosed = resolve; });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? rows : []);
    let loadingClosed = false;
    const eq = result.eq;
    const limit = result.limit;
    result.eq = (field, value) => { if (field === 'status' && value === 'closed') loadingClosed = true; return eq(field, value); };
    result.limit = (count) => loadingClosed ? closedPage : limit(count);
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Closing work' });
  fireEvent.click(screen.getByRole('button', { name: 'Show closed sessions' }));
  const newlyClosed = { ...active, status: 'closed' };
  rows = [newlyClosed, previouslyClosed];
  act(() => onSession?.({ eventType: 'UPDATE', new: newlyClosed }));
  await act(async () => finishClosed({ data: [previouslyClosed], error: null }));
  const history = screen.getByRole('region', { name: 'Closed Vibe sessions' });
  expect(within(history).getByRole('button', { name: /Closing work/ })).toBeTruthy();
  expect(within(history).getByRole('button', { name: /Earlier work/ })).toBeTruthy();
});

it('reconciles an open closed-history list after missed session changes', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const active = session('s', 'Work closed while offline');
  const removed = { ...session('z', 'Unavailable closed work'), status: 'closed' };
  const older = Array.from({ length: 51 }, (_, index) => ({
    ...session(`older-${String(index).padStart(3, '0')}`, `Earlier closed work ${index}`), status: 'closed',
  }));
  let rows = [active, removed, ...older];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? rows : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Work closed while offline' });
  fireEvent.click(screen.getByRole('button', { name: 'Show closed sessions' }));
  const history = screen.getByRole('region', { name: 'Closed Vibe sessions' });
  await within(history).findByRole('button', { name: /Unavailable closed work/ });
  fireEvent.click(within(history).getByRole('button', { name: 'Load older closed sessions' }));
  await within(history).findByRole('button', { name: /Earlier closed work 0\b/ });
  act(() => connection?.('CHANNEL_ERROR'));
  rows = [{ ...active, status: 'closed' }, ...older];
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));

  expect(await within(history).findByRole('button', { name: /Work closed while offline/ })).toBeTruthy();
  expect(within(history).queryByRole('button', { name: /Unavailable closed work/ })).toBeNull();
  expect(within(history).getByRole('button', { name: /Earlier closed work 0\b/ })).toBeTruthy();
});

it('reports when a created Vibe session reference cannot be loaded', async () => {
  wireRealtime();
  const active = session('s', 'Existing work');
  rpc.mockImplementation((name: string) => Promise.resolve(name === 'builder_vibe_session_open'
    ? { data: 'created-id', error: null } : { data: true, error: null }));
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [active] : []);
    let lookup = false;
    const eq = result.eq;
    const limit = result.limit;
    result.eq = (field, value) => { if (field === 'id' && value === 'created-id') lookup = true; return eq(field, value); };
    result.limit = (count) => lookup
      ? Promise.resolve({ data: null, error: { message: 'Reference lookup unavailable' } })
      : limit(count);
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Existing work' });
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  expect(await screen.findByText(/session was created, but its reference could not be loaded/i)).toBeTruthy();
  expect(screen.queryByText(/Started VB-/)).toBeNull();
});

it('keeps an older selected session and its draft when reloading the session connection', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 51 }, (_, index) =>
    session(String(index + 1).padStart(3, '0'), `Session ${String(index + 1).padStart(3, '0')}`));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 051');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /Session 001/ }));
  fireEvent.change(await screen.findByLabelText('Tell Bob what to build'), { target: { value: 'Keep working here' } });
  act(() => connection?.('CHANNEL_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));

  await waitFor(() => expect(screen.getByRole('button', { name: /Session 001/ }).getAttribute('aria-current')).toBe('true'));
  expect((screen.getByLabelText('Tell Bob what to build') as HTMLTextAreaElement).value).toBe('Keep working here');
  expect(screen.queryByRole('region', { name: 'Unsent drafts' })).toBeNull();
});

it('refreshes an older selected session after its status changes while disconnected', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 51 }, (_, index) => ({
    ...session(String(index + 1).padStart(3, '0'), `Session ${String(index + 1).padStart(3, '0')}`),
    status: index === 0 ? 'working' : 'open',
    changed_files: index === 0 ? ['updated.ts'] : [],
  }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 051');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /Session 001/ }));
  expect((screen.getByRole('button', { name: 'Ship as PR' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => connection?.('CHANNEL_ERROR'));
  sessions[0] = { ...sessions[0], status: 'open' };
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Ship as PR' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('heading', { name: 'Session 001' })).toBeTruthy();
});

it('does not skip an unloaded session whose activity changed while disconnected', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 151 }, (_, index) => ({
    ...session(String(index + 1).padStart(3, '0'), `Session ${String(index + 1).padStart(3, '0')}`),
    last_activity_at: index >= 101 ? '2026-11-11T00:00:00.000Z' : '2026-11-10T00:00:00.000Z',
  }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 151');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Session 052');
  expect(screen.queryByText('Session 001')).toBeNull();
  act(() => connection?.('CHANNEL_ERROR'));
  sessions[0] = { ...sessions[0], last_activity_at: '2026-11-10T12:00:00.000Z' };
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  await waitFor(() => expect(screen.queryByText('Loading sessions…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  expect(await screen.findByText('Session 001')).toBeTruthy();
});

it('does not skip unloaded sessions when an older session receives a realtime update', async () => {
  const listeners = new Map<string, (change: { new: ReturnType<typeof session>; eventType: string }) => void>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => { listeners.set(name, listener); return sub; },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`, `Session ${String(number).padStart(3, '0')}`);
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 105');
  await waitFor(() => expect(listeners.has('builder-vibe-sessions')).toBe(true));
  act(() => listeners.get('builder-vibe-sessions')!({ new: sessions[0], eventType: 'UPDATE' }));
  await screen.findByText('Session 001');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Session 006');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Session 002');
  expect(screen.getAllByText('Session 001')).toHaveLength(1);
});

it('selects the newest realtime session when it arrives during the first list request', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  let resolveFirst!: (result: QueryResult) => void;
  const first = new Promise<QueryResult>((resolve) => { resolveFirst = resolve; });
  const older = session('a', 'Old snapshot');
  const newer = { ...session('b', 'New live session'), last_activity_at: '2026-11-11T00:00:00.000Z' };
  const sessions = [older];
  let initial = true;
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => {
    const builder = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    if (table === 'builder_vibe_sessions' && initial) {
      initial = false;
      builder.limit = () => first;
    }
    return builder;
  });

  render(<BuilderVibePage />);
  await waitFor(() => expect(onSession).toBeDefined());
  act(() => { sessions.push(newer); onSession?.({ new: newer, eventType: 'INSERT' }); });
  await act(async () => { resolveFirst({ data: [older], error: null }); await first; });
  await waitFor(() => expect(screen.getByRole('button', { name: /New live session/ }).getAttribute('aria-current')).toBe('true'));
  expect(screen.getByRole('heading', { name: 'New live session' })).toBeTruthy();
});

it('does not miss a session saved before session updates become active', async () => {
  let subscriptionReady: ((status: string) => void) | undefined;
  const listeners = new Set<string>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => { listeners.add(name); return sub; },
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') subscriptionReady = callback;
        else callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = [session('a', 'Original session')];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await waitFor(() => expect(listeners.has('builder-vibe-sessions')).toBe(true));
  await screen.findAllByText('Original session');
  sessions.push({ ...session('b', 'Saved while connecting'), last_activity_at: '2026-11-11T00:00:00.000Z' });
  act(() => subscriptionReady?.('SUBSCRIBED'));
  expect(await screen.findAllByText('Saved while connecting')).not.toHaveLength(0);
});

it('removes a session closed before live session updates become active', async () => {
  let subscriptionReady: ((status: string) => void) | undefined;
  const listeners = new Set<string>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => { listeners.add(name); return sub; },
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') subscriptionReady = callback;
        else callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = [session('a', 'Closed during connection'), session('b', 'Still open')];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findByText('Closed during connection');
  sessions[0] = { ...sessions[0], status: 'closed' };
  act(() => subscriptionReady?.('SUBSCRIBED'));
  await waitFor(() => expect(screen.queryByText('Closed during connection')).toBeNull());
  expect(screen.getAllByText('Still open').length).toBeGreaterThan(0);
});

it('keeps older sessions and the current selection when reconciling missed closes', async () => {
  let subscriptionReady: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') subscriptionReady = callback;
        else callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`, `Session ${String(number).padStart(3, '0')}`);
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 105');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /Session 006/ }));
  await screen.findByRole('heading', { name: 'Session 006' });
  sessions[99] = { ...sessions[99], status: 'closed' };
  act(() => subscriptionReady?.('SUBSCRIBED'));
  await waitFor(() => expect(screen.queryByText('Session 100')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Session 006' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Session 007/ })).toBeTruthy();
});

it('recovers a draft when its session was deleted while disconnected', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = [session('s', 'Deleted session')];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByLabelText('Tell Bob what to build'), { target: { value: 'Save this draft' } });
  act(() => connection?.('CHANNEL_ERROR'));
  sessions.splice(0, sessions.length);
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  const draft = await screen.findByRole('textbox', { name: 'Unsent draft for Deleted session' }) as HTMLTextAreaElement;
  expect(draft.value).toBe('Save this draft');
  expect(screen.queryByRole('button', { name: /Deleted session/ })).toBeNull();
});

it('reconciles an older page that finishes after the session subscription connects', async () => {
  let subscriptionReady: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') subscriptionReady = callback;
        else callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`, `Session ${String(number).padStart(3, '0')}`);
  });
  const stalePage = sessions.slice(4, 55).reverse();
  let resolveOlder!: (value: QueryResult) => void;
  const older = new Promise<QueryResult>((resolve) => { resolveOlder = resolve; });
  let reconciliationQueries = 0;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    let olderPage = false;
    let checkingClosed = false;
    const or = result.or;
    const inFilter = result.in;
    const limit = result.limit;
    result.or = (expression) => { olderPage = true; or(expression); return result; };
    result.in = (field, values) => { if (field === 'id') checkingClosed = true; inFilter(field, values); return result; };
    result.limit = (count) => {
      if (checkingClosed) reconciliationQueries += 1;
      return olderPage ? older : limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 105');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  sessions[19] = { ...sessions[19], status: 'closed' };
  act(() => subscriptionReady?.('SUBSCRIBED'));
  await waitFor(() => expect(reconciliationQueries).toBeGreaterThan(0));
  await act(async () => { resolveOlder({ data: stalePage, error: null }); await older; });
  await screen.findByText('Session 006');
  await waitFor(() => expect(screen.queryByText('Session 020')).toBeNull());
});

it('finishes loading sessions even if realtime updates arrive faster than queries', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  let resolveInitial!: (value: QueryResult) => void;
  const initial = new Promise<QueryResult>((resolve) => { resolveInitial = resolve; });
  const pending = new Promise<QueryResult>(() => {});
  let requests = 0;
  const active = session('s', 'Active session');
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [active] : []);
    if (table === 'builder_vibe_sessions') result.limit = () => ++requests === 1 ? initial : pending;
    return result;
  });

  render(<BuilderVibePage />);
  await waitFor(() => expect(onSession).toBeDefined());
  act(() => {
    onSession?.({ new: active, eventType: 'UPDATE' });
    onSession?.({ new: active, eventType: 'UPDATE' });
  });
  await act(async () => { resolveInitial({ data: [active], error: null }); await initial; });
  await screen.findAllByText('Active session');
  expect(screen.queryByText('Loading sessions…')).toBeNull();
});

it('keeps a realtime session update when an older list request finishes', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  let resolveInitial!: (value: QueryResult) => void;
  const initial = new Promise<QueryResult>((resolve) => { resolveInitial = resolve; });
  const pending = new Promise<QueryResult>(() => {});
  const old = session('s', 'Old session title');
  const updated = { ...old, title: 'Updated session title' };
  let requests = 0;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [old] : []);
    if (table === 'builder_vibe_sessions') result.limit = () => ++requests === 1 ? initial : pending;
    return result;
  });

  render(<BuilderVibePage />);
  await waitFor(() => expect(onSession).toBeDefined());
  act(() => onSession?.({ new: updated, eventType: 'UPDATE' }));
  await act(async () => { resolveInitial({ data: [old], error: null }); await initial; });
  await screen.findAllByText('Updated session title');
  expect(screen.queryByText('Old session title')).toBeNull();
});

it('offers a session-list retry after a realtime refresh fails', async () => {
  let sessionChange: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') sessionChange = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = [session('a', 'Existing session')];
  let requests = 0;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    const limit = result.limit;
    result.limit = async (count) => {
      if (table === 'builder_vibe_sessions' && ++requests === 2) {
        return { data: null, error: { message: 'Session refresh failed' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findAllByText('Existing session');
  sessions.push({ ...session('b', 'New session'), last_activity_at: '2026-11-11T00:00:00.000Z' });
  act(() => sessionChange?.({ new: sessions[0], eventType: 'UPDATE' }));
  await screen.findByText('Session refresh failed');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading sessions' }));
  await screen.findByText('New session');
});

it('clears a session-list error when a later live refresh succeeds', async () => {
  let sessionChange: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') sessionChange = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = [session('a', 'Existing session')];
  let requests = 0;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    const limit = result.limit;
    result.limit = async (count) => {
      if (table === 'builder_vibe_sessions' && ++requests === 2) {
        return { data: null, error: { message: 'Session refresh failed' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findAllByText('Existing session');
  act(() => sessionChange?.({ new: sessions[0], eventType: 'UPDATE' }));
  await screen.findByText('Session refresh failed');
  act(() => sessionChange?.({ new: sessions[0], eventType: 'UPDATE' }));
  await waitFor(() => expect(screen.queryByText('Session refresh failed')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Retry loading sessions' })).toBeNull();
});

it('keeps an older-session-page failure visible through a separate list refresh', async () => {
  let sessionChange: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') sessionChange = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 51 }, (_, index) =>
    session(`00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`, `Session ${index + 1}`));
  let listRequests = 0;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    let older = false;
    const or = result.or;
    const limit = result.limit;
    result.or = (expression) => { older = true; or(expression); return result; };
    result.limit = async (count) => {
      if (table === 'builder_vibe_sessions' && older) return { data: null, error: { message: 'Older sessions failed' } };
      if (table === 'builder_vibe_sessions' && ++listRequests === 2) return { data: null, error: { message: 'Session refresh failed' } };
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByRole('button', { name: 'Load older sessions' });
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('Older sessions failed');
  act(() => sessionChange?.({ new: sessions[0], eventType: 'UPDATE' }));
  await screen.findByText('Session refresh failed');
  expect(screen.getByText('Older sessions failed')).toBeTruthy();
  act(() => sessionChange?.({ new: sessions[0], eventType: 'UPDATE' }));
  await waitFor(() => expect(screen.queryByText('Session refresh failed')).toBeNull());
  expect(screen.getByText('Older sessions failed')).toBeTruthy();
});

it('ignores a previous older-session request after the list is reloaded', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return session(`00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`, `Session ${String(number).padStart(3, '0')}`);
  });
  const stalePage = sessions.slice(4, 55).reverse();
  let resolveOlder!: (value: QueryResult) => void;
  const olderSessions = new Promise<QueryResult>((resolve) => { resolveOlder = resolve; });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? sessions : []);
    let older = false;
    const or = result.or;
    const limit = result.limit;
    result.or = (expression) => { older = true; or(expression); return result; };
    result.limit = (count) => older ? olderSessions : limit(count);
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findAllByText('Session 105');
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  act(() => connection?.('CHANNEL_ERROR'));
  sessions.splice(0, sessions.length, session('fresh', 'Fresh session'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  await screen.findAllByText('Fresh session');
  await act(async () => { resolveOlder({ data: stalePage, error: null }); await olderSessions; });
  expect(screen.queryByText('Session 020')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load older sessions' })).toBeNull();
});

it('preserves the reading position when earlier messages are prepended', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = Array.from({ length: 101 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Reading position')] : messages));
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  try {
    render(<BuilderVibePage />);
    await screen.findByText('Message 101');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const thread = screen.getByRole('region', { name: 'Conversation with Bob' }).querySelector<HTMLDivElement>('.vibe-thread')!;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => thread.querySelectorAll('.vibe-msg').length * 10 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 100 });
    thread.scrollTop = 200;
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 1');
    expect(thread.scrollTop).toBe(210);
    expect(scrollIntoView).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('does not scroll a reader away from older messages when a live message arrives', async () => {
  let onMessage: ((change: { new: VibeMessage; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions'
    ? [session('s', 'Reading history')] : [{ ...message('m1', 1, 'bob', 'message', 'First message') }]));
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  try {
    render(<BuilderVibePage />);
    await screen.findByText('First message');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const thread = screen.getByRole('region', { name: 'Conversation with Bob' }).querySelector<HTMLDivElement>('.vibe-thread')!;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 100 });
    vi.spyOn(thread, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
    vi.spyOn(thread.lastElementChild!, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 1000 - thread.scrollTop, 0, 0));
    thread.scrollTop = 0;
    scrollIntoView.mockClear();
    act(() => onMessage?.({ new: message('m2', 2, 'bob', 'message', 'New while reading'), eventType: 'INSERT' }));
    await screen.findByText('New while reading');
    expect(scrollIntoView).not.toHaveBeenCalled();
    thread.scrollTop = 900;
    act(() => onMessage?.({ new: message('m3', 3, 'bob', 'message', 'New at bottom'), eventType: 'INSERT' }));
    await screen.findByText('New at bottom');
    expect(scrollIntoView).toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('keeps realtime messages and updates that arrive before the first history page', async () => {
  const listeners = new Map<string, (change: { new: VibeMessage; eventType: string }) => void>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => { listeners.set(name, listener); return sub; },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  let resolveHistory!: (value: QueryResult) => void;
  const history = new Promise<QueryResult>((resolve) => { resolveHistory = resolve; });
  from.mockImplementation((table: string) => {
    if (table === 'builder_vibe_sessions') return pagedQuery([session('s', 'Live session')]);
    const result = pagedQuery([]);
    result.limit = () => history;
    return result;
  });

  render(<BuilderVibePage />);
  await waitFor(() => expect(listeners.has('builder-vibe-s')).toBe(true));
  act(() => {
    listeners.get('builder-vibe-s')!({ new: message('m1', 1, 'bob', 'message', 'Updated live'), eventType: 'UPDATE' });
    listeners.get('builder-vibe-s')!({ new: message('m2', 2, 'bob', 'message', 'New live'), eventType: 'INSERT' });
  });
  await screen.findByText('New live');
  await act(async () => { resolveHistory({ data: [{ ...message('m1', 1, 'bob', 'message', 'Outdated snapshot') }], error: null }); await history; });
  expect(screen.getByText('Updated live')).toBeTruthy();
  expect(screen.getByText('New live')).toBeTruthy();
  expect(screen.queryByText('Outdated snapshot')).toBeNull();
});

it('does not miss a message saved before the live subscription becomes active', async () => {
  let subscriptionReady: ((status: string) => void) | undefined;
  const listeners = new Set<string>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => { listeners.add(name); return sub; },
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') subscriptionReady = callback;
        else callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = [{ ...message('m1', 1, 'bob', 'message', 'First message') }];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Connecting')] : messages));

  render(<BuilderVibePage />);
  await waitFor(() => expect(listeners.has('builder-vibe-s')).toBe(true));
  messages.push({ ...message('m2', 2, 'bob', 'message', 'Saved while connecting') });
  act(() => subscriptionReady?.('SUBSCRIBED'));
  expect(await screen.findByText('Saved while connecting')).toBeTruthy();
});

it('loads the conversation and warns when live updates cannot connect', async () => {
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => { callback?.(name === 'builder-vibe-s' ? 'CHANNEL_ERROR' : 'SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions'
    ? [session('s', 'Offline live updates')] : [{ ...message('m1', 1, 'bob', 'message', 'Saved history') }]));

  render(<BuilderVibePage />);
  await screen.findByText('Saved history');
  expect(screen.getByText(/Live updates are unavailable/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload conversation' })).toBeTruthy();
});

it('reloads missed history after a live connection is interrupted', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = [{ ...message('m1', 1, 'bob', 'message', 'First message') }];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Reconnect')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('First message');
  act(() => connection?.('CHANNEL_ERROR'));
  messages.push({ ...message('m2', 2, 'bob', 'message', 'Missed while offline') });
  act(() => connection?.('SUBSCRIBED'));
  expect(screen.getByText(/activity missed while disconnected/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
  await screen.findByText('Missed while offline');
  expect(screen.queryByText(/activity missed while disconnected/)).toBeNull();
});

it('warns that older unloaded history may contain missed messages after reconnecting', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  const messages = Array.from({ length: 205 }, (_, index) =>
    ({ ...message(`m${index + 2}`, index + 2, 'bob', 'message', `Message ${index + 2}`) }));
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions'
    ? [session('s', 'Reconnect')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('Message 206');
  act(() => connection?.('CHANNEL_ERROR'));
  messages.push(message('m1', 1, 'bob', 'message', 'Committed while disconnected'));
  act(() => connection?.('SUBSCRIBED'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
  expect(await screen.findByText(/earlier messages may contain activity missed while disconnected/i)).toBeTruthy();
  expect(screen.queryByText('Committed while disconnected')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 7');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Committed while disconnected');
  await waitFor(() => expect(screen.queryByText(/earlier messages may contain activity missed while disconnected/i)).toBeNull());
});

it('allows a connected owner to refresh messages after a server-side deletion', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = [
    { ...message('m1', 1, 'bob', 'message', 'Deleted on server') },
    { ...message('m2', 2, 'bob', 'message', 'Still on server') },
  ];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Refresh')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('Deleted on server');
  messages.shift();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(screen.queryByText('Deleted on server')).toBeNull());
  expect(screen.getByText('Still on server')).toBeTruthy();
});

it('clears a failed conversation-load error after a successful manual refresh', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let fail = true;
  const messages = [{ ...message('m1', 1, 'bob', 'message', 'Recovered conversation') }];
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Refresh')] : messages);
    const limit = result.limit;
    result.limit = async (count) => {
      if (table === 'builder_vibe_messages' && fail) {
        fail = false;
        return { data: null, error: { message: 'Conversation load failed' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Conversation load failed');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await screen.findByText('Recovered conversation');
  await waitFor(() => expect(screen.queryByText('Conversation load failed')).toBeNull());
});

it('preserves an attachment validation error while a failed conversation load recovers', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let fail = true;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Refresh')] : []);
    const limit = result.limit;
    result.limit = async (count) => {
      if (table === 'builder_vibe_messages' && fail) {
        fail = false;
        return { data: null, error: { message: 'Conversation load failed' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Conversation load failed');
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), {
    target: { files: [new File(['fixture'], 'unsupported.exe', { type: 'application/octet-stream' })] },
  });
  expect(screen.getByText('Conversation load failed')).toBeTruthy();
  expect(screen.getByText(/unsupported.exe is not a supported/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(screen.queryByText('Conversation load failed')).toBeNull());
  expect(screen.getByText(/unsupported.exe is not a supported/)).toBeTruthy();
});

it('keeps an older-message-page failure separate from conversation refresh errors', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let failOlder = true;
  let failRefresh = false;
  const messages = Array.from({ length: 101 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Refresh')] : messages);
    let older = false;
    const lt = result.lt;
    const limit = result.limit;
    result.lt = (field, value) => { older = true; lt(field, value); return result; };
    result.limit = async (count) => {
      if (table === 'builder_vibe_messages' && older && count === 101 && failOlder) {
        failOlder = false;
        return { data: null, error: { message: 'Older messages failed' } };
      }
      if (table === 'builder_vibe_messages' && !older && failRefresh) {
        failRefresh = false;
        return { data: null, error: { message: 'Conversation refresh failed' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 101');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Older messages failed');
  failRefresh = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await screen.findByText('Conversation refresh failed');
  expect(screen.getByText('Older messages failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(screen.queryByText('Conversation refresh failed')).toBeNull());
  expect(screen.getByText('Older messages failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 1');
  expect(screen.queryByText('Older messages failed')).toBeNull();
});

it('preserves loaded history and expanded steps while reconciling all missed messages', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = Array.from({ length: 205 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, index === 9 ? 'tool' : 'bob', index === 9 ? 'tool' : 'message', `Message ${index + 1}`) }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Long session')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('Message 205');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 6');
  fireEvent.click(screen.getByRole('button', { name: /1 step/ }));
  expect(screen.getByRole('button', { name: /1 step/ }).getAttribute('aria-expanded')).toBe('true');

  act(() => connection?.('CHANNEL_ERROR'));
  messages[9] = { ...messages[9], content: 'Updated older step' };
  messages.splice(messages.findIndex((item) => item.id === 'm11'), 1);
  messages.push(...Array.from({ length: 150 }, (_, index) =>
    message(`m${index + 206}`, index + 206, 'bob', 'message', `Missed ${index + 206}`)));
  act(() => connection?.('SUBSCRIBED'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));

  await screen.findByText('Missed 355');
  await screen.findByText('Updated older step');
  expect(screen.getByText('Message 6')).toBeTruthy();
  expect(screen.getByText('Missed 206')).toBeTruthy();
  expect(screen.queryByText('Message 11')).toBeNull();
  expect(screen.getByRole('button', { name: /1 step/ }).getAttribute('aria-expanded')).toBe('true');
});

it('keeps realtime updates and deletes that arrive during history reconciliation', async () => {
  type Change = { new?: VibeMessage; old?: { id: string }; eventType: string };
  let connection: ((status: string) => void) | undefined;
  let onMessage: ((change: Change) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: Change) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  let resolveRange!: (result: QueryResult) => void;
  const pending = new Promise<QueryResult>((resolve) => { resolveRange = resolve; });
  let rangeRequested = false;
  const messages = [
    { ...message('m1', 1, 'bob', 'message', 'First original') },
    { ...message('m2', 2, 'bob', 'message', 'Second original') },
  ];
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Reconnect')] : messages);
    let range = false;
    const gte = result.gte;
    const limit = result.limit;
    result.gte = (field, value) => { range = true; gte(field, value); return result; };
    result.limit = (count) => {
      if (table === 'builder_vibe_messages' && range && !rangeRequested) {
        rangeRequested = true;
        return pending;
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Second original');
  act(() => connection?.('CHANNEL_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
  await waitFor(() => expect(rangeRequested).toBe(true));
  act(() => {
    onMessage?.({ eventType: 'UPDATE', new: { ...messages[0], content: 'First updated live' } });
    onMessage?.({ eventType: 'DELETE', old: { id: 'm2' } });
  });
  await act(async () => { resolveRange({ data: messages, error: null }); await pending; });
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect(screen.getByText('First updated live')).toBeTruthy();
  expect(screen.queryByText('Second original')).toBeNull();
});

it('does not pull an unloaded older update into the visible window during refresh', async () => {
  let onMessage: ((change: { new: VibeMessage; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  let finishRange!: (result: QueryResult) => void;
  const pending = new Promise<QueryResult>(resolve => { finishRange = resolve; });
  let delayedRange = false;
  const messages = Array.from({ length: 205 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Bounded refresh')] : messages);
    let range = false;
    const gte = result.gte;
    const limit = result.limit;
    result.gte = (field, value) => { range = true; return gte(field, value); };
    result.limit = (count) => {
      if (table === 'builder_vibe_messages' && range && !delayedRange) {
        delayedRange = true;
        return pending;
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 205');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(delayedRange).toBe(true));
  act(() => onMessage?.({ eventType: 'UPDATE', new: { ...messages[0], content: 'Unloaded older update' } }));
  await act(async () => finishRange({ data: messages.slice(105), error: null }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect(screen.queryByText('Unloaded older update')).toBeNull();
  expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeTruthy();
});

it('refreshes a late older insert without expanding the contiguous history window', async () => {
  let onMessage: ((change: { new: VibeMessage; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  const messages = Array.from({ length: 205 }, (_, index) =>
    ({ ...message(`m${index + 2}`, index + 2, 'bob', 'message', `Message ${index + 2}`) }));
  const floors: number[] = [];
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Late insert')] : messages);
    const gte = result.gte;
    result.gte = (field, value) => { if (table === 'builder_vibe_messages') floors.push(value); return gte(field, value); };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 206');
  const late = message('m1', 1, 'bob', 'message', 'Late committed message');
  messages.push(late);
  act(() => onMessage?.({ eventType: 'INSERT', new: late }));
  await screen.findByText('Late committed message');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(floors.length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect(floors.every(floor => floor === 107)).toBe(true);
  expect(screen.getByText('Late committed message')).toBeTruthy();
  expect(screen.queryByText('Message 2')).toBeNull();
});

it('removes a deleted late older insert when refreshing the conversation', async () => {
  let onMessage: ((change: { new: VibeMessage; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  const messages = Array.from({ length: 205 }, (_, index) =>
    ({ ...message(`m${index + 2}`, index + 2, 'bob', 'message', `Message ${index + 2}`) }));
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions'
    ? [session('s', 'Late insert')] : messages));

  render(<BuilderVibePage />);
  await screen.findByText('Message 206');
  const late = message('m1', 1, 'bob', 'message', 'Deleted late message');
  messages.push(late);
  act(() => onMessage?.({ eventType: 'INSERT', new: late }));
  await screen.findByText('Deleted late message');
  messages.pop();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await waitFor(() => expect(screen.queryByText('Deleted late message')).toBeNull());
  expect(screen.getByText('Message 206')).toBeTruthy();
});

it('waits for an older page before retrying a failed conversation reload', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-s') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  let failReload = false;
  let resolveOlder!: (result: QueryResult) => void;
  const pending = new Promise<QueryResult>((resolve) => { resolveOlder = resolve; });
  const messages = Array.from({ length: 101 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Retry conversation')] : messages);
    let older = false;
    const lt = result.lt;
    const limit = result.limit;
    result.lt = (field, value) => { older = true; lt(field, value); return result; };
    result.limit = (count) => {
      if (table === 'builder_vibe_messages' && older && count === 101) return pending;
      if (table === 'builder_vibe_messages' && !older && failReload) {
        failReload = false;
        return Promise.resolve({ data: null, error: { message: 'Conversation reload failed' } });
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 101');
  act(() => connection?.('CHANNEL_ERROR'));
  failReload = true;
  fireEvent.click(screen.getByRole('button', { name: 'Reload conversation' }));
  const retry = await screen.findByRole('button', { name: 'Retry loading conversation' }) as HTMLButtonElement;
  messages.push({ ...message('m102', 102, 'bob', 'message', 'Missed message') });
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  expect(retry.disabled).toBe(true);
  await act(async () => { resolveOlder({ data: [messages[0]], error: null }); await pending; });
  expect(screen.getByRole('button', { name: 'Retry loading conversation' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading conversation' }));
  expect(await screen.findByText('Missed message')).toBeTruthy();
});

it('offers a retry instead of presenting a failed session query as empty history', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let fail = true;
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Recovered session')] : []);
    const limit = result.limit;
    result.limit = async (count) => {
      if (table === 'builder_vibe_sessions' && fail) {
        fail = false;
        return { data: null, error: { message: 'Sessions temporarily unavailable' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Sessions temporarily unavailable');
  expect(screen.queryByText(/No sessions yet/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading sessions' }));
  await screen.findAllByText('Recovered session');
});

it('keeps an update to an unloaded message when it arrives during an older-page request', async () => {
  const listeners = new Map<string, (change: { new: VibeMessage; eventType: string }) => void>();
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => { listeners.set(name, listener); return sub; },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = Array.from({ length: 102 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  let resolveOlder!: (value: QueryResult) => void;
  const olderHistory = new Promise<QueryResult>((resolve) => { resolveOlder = resolve; });
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Older update')] : messages);
    let older = false;
    const lt = result.lt;
    const limit = result.limit;
    result.lt = (field, value) => { older = true; lt(field, value); return result; };
    result.limit = (count) => older ? olderHistory : limit(count);
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 102');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  act(() => listeners.get('builder-vibe-s')!({ new: message('m1', 1, 'bob', 'message', 'Updated older message'), eventType: 'UPDATE' }));
  await act(async () => { resolveOlder({ data: [messages[1], messages[0]], error: null }); await olderHistory; });
  expect(screen.getByText('Updated older message')).toBeTruthy();
  expect(screen.queryByText('Message 1')).toBeNull();
});

it('keeps tool steps grouped across a message-page boundary', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const messages = Array.from({ length: 101 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'tool', 'tool', `Step ${index + 1}`) }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Tool steps')] : messages));

  render(<BuilderVibePage />);
  fireEvent.click(await screen.findByRole('button', { name: /100 steps/ }));
  expect(screen.getByRole('button', { name: /100 steps/ }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  const expanded = await screen.findByRole('button', { name: /101 steps/ });
  expect(expanded.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: /100 steps/ })).toBeNull();
});

it('does not replace the selected session with an older request that finishes late', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let resolveFirst!: (value: QueryResult) => void;
  const firstHistory = new Promise<QueryResult>((resolve) => { resolveFirst = resolve; });
  const alpha = session('a', 'Alpha');
  const beta = { ...session('b', 'Beta'), last_activity_at: '2026-11-09T00:00:00.000Z' };
  const betaMessage = { ...message('b1', 2, 'bob', 'message', 'Beta result'), session_id: 'b' };
  from.mockImplementation((table: string) => {
    if (table === 'builder_vibe_sessions') return pagedQuery([alpha, beta]);
    const result = pagedQuery([betaMessage]);
    let sessionId = '';
    const eq = result.eq;
    const limit = result.limit;
    result.eq = (field, value) => { if (field === 'session_id') sessionId = String(value); eq(field, value); return result; };
    result.limit = (count) => sessionId === 'a' ? firstHistory : limit(count);
    return result;
  });

  render(<BuilderVibePage />);
  fireEvent.click(await screen.findByRole('button', { name: /Beta/ }));
  await screen.findByText('Beta result');
  await act(async () => {
    resolveFirst({ data: [{ ...message('a1', 1, 'bob', 'message', 'Alpha result'), session_id: 'a' }], error: null });
    await firstHistory;
  });
  expect(screen.getByText('Beta result')).toBeTruthy();
  expect(screen.queryByText('Alpha result')).toBeNull();
});

it('keeps unsent drafts separate when switching sessions', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  const alpha = session('a', 'Alpha');
  const beta = { ...session('b', 'Beta'), last_activity_at: '2026-11-09T00:00:00.000Z' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [alpha, beta] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'Draft for Alpha' } });
  fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Tell Bob what to build' }), { target: { value: 'Draft for Beta' } });
  fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('Draft for Alpha');
  fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('Draft for Beta');
});

it('reuses the request id when retrying the same message after an uncertain send error', async () => {
  wireRealtime();
  const requestIds: string[] = [];
  rpc.mockImplementation(async (name: string, args?: { p_client_request_id?: string }) => {
    if (name === 'builder_vibe_send_with_attachments_opt_in') {
      requestIds.push(String(args?.p_client_request_id));
      return requestIds.length === 1
        ? { data: null, error: { message: 'Connection lost' } }
        : { data: 'message-id', error: null };
    }
    return { data: true, error: null };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Retry')] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'Review the current work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Connection lost/);
  expect((draft as HTMLTextAreaElement).value).toBe('Review the current work');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(requestIds).toHaveLength(2));
  expect(requestIds[1]).toBe(requestIds[0]);
});

it('uses a fresh request id for an edited draft and a later identical successful message', async () => {
  wireRealtime();
  const requestIds: string[] = [];
  rpc.mockImplementation(async (name: string, args?: { p_client_request_id?: string }) => {
    if (name === 'builder_vibe_send_with_attachments_opt_in') {
      requestIds.push(String(args?.p_client_request_id));
      return requestIds.length === 1
        ? { data: null, error: { message: 'Connection lost' } }
        : { data: 'message-id', error: null };
    }
    return { data: true, error: null };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Retry')] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'Original request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Connection lost/);
  fireEvent.change(draft, { target: { value: 'Revised request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe(''));
  fireEvent.change(draft, { target: { value: 'Revised request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(requestIds).toHaveLength(3));
  expect(new Set(requestIds).size).toBe(3);
});

it('keeps an unsent draft with its selected session after sessions reload', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const alpha = session('a', 'Alpha');
  const beta = { ...session('b', 'Beta'), last_activity_at: '2026-11-09T00:00:00.000Z' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [alpha, beta] : []));

  render(<BuilderVibePage />);
  fireEvent.click(await screen.findByRole('button', { name: /Beta/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'Draft for Beta' } });
  act(() => connection?.('CHANNEL_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  await waitFor(() => expect(screen.queryByText('Loading sessions…')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('Draft for Beta');
  fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
  await waitFor(() => expect(screen.queryByText('Loading conversation…')).toBeNull());
  expect((screen.getByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement).value).toBe('Draft for Beta');
});

it('does not close a session while its draft is unsent', async () => {
  wireRealtime();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Unsent draft')] : []));

  try {
    render(<BuilderVibePage />);
    const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(screen.getByRole('alert').textContent).toMatch(/draft/i);
    expect(rpc).not.toHaveBeenCalledWith('builder_vibe_session_close', expect.anything());
  } finally {
    confirm.mockRestore();
  }
});

it('preserves newer edits to a draft while an earlier send is pending', async () => {
  wireRealtime();
  let resolveSend!: (value: { data: null; error: null }) => void;
  const pending = new Promise<{ data: null; error: null }>((resolve) => { resolveSend = resolve; });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_send_with_attachments_opt_in'
    ? pending : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Pending send')] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: 'First request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(draft, { target: { value: 'A later request' } });
  await act(async () => { resolveSend({ data: null, error: null }); await pending; });
  expect(draft.value).toBe('A later request');
});

it('preserves a draft edited back to its submitted text while a send is pending', async () => {
  wireRealtime();
  let resolveSend!: (value: { data: null; error: null }) => void;
  const pending = new Promise<{ data: null; error: null }>((resolve) => { resolveSend = resolve; });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_send_with_attachments_opt_in'
    ? pending : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Pending send')] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' }) as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: 'Same request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(draft, { target: { value: 'Something else' } });
  fireEvent.change(draft, { target: { value: 'Same request' } });
  await act(async () => { resolveSend({ data: null, error: null }); await pending; });
  expect(draft.value).toBe('Same request');
});

it('keeps recovery work when a session closes before a send response arrives', async () => {
  let connection: ((status: string) => void) | undefined;
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  let resolveSend!: (value: { data: null; error: null }) => void;
  const pending = new Promise<{ data: null; error: null }>((resolve) => { resolveSend = resolve; });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_send_with_attachments_opt_in'
    ? pending : Promise.resolve({ data: true, error: null }));
  storageFrom.mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn() });
  const sessions = [session('s', 'Closing session')];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByLabelText('Tell Bob what to build'), { target: { value: 'Save this request' } });
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), {
    target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_vibe_send_with_attachments_opt_in', expect.anything()));
  sessions[0] = { ...sessions[0], status: 'closed' };
  act(() => onSession?.({ new: sessions[0], eventType: 'UPDATE' }));
  await screen.findByRole('textbox', { name: 'Unsent draft for Closing session' });
  act(() => connection?.('CHANNEL_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  await waitFor(() => expect(screen.queryByText('Loading sessions…')).toBeNull());
  await act(async () => { resolveSend({ data: null, error: null }); await pending; });
  expect((screen.getByRole('textbox', { name: 'Unsent draft for Closing session' }) as HTMLTextAreaElement).value).toBe('Save this request');
  expect(screen.getByRole('button', { name: 'Clear local selection of photo.png' })).toBeTruthy();
  expect(screen.getByText(/may already have been saved/)).toBeTruthy();
});

it('shows a successfully saved request in closed history when closure arrives after confirmation', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  let resolveSend!: (value: { data: string; error: null }) => void;
  const pending = new Promise<{ data: string; error: null }>(resolve => { resolveSend = resolve; });
  const sessions = [session('s', 'Closing session')];
  const messages: Array<Record<string, unknown>> = [];
  rpc.mockImplementation((name: string) => name === 'builder_vibe_send_with_attachments_opt_in'
    ? pending : Promise.resolve({ data: true, error: null }));
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : messages));
  storageFrom.mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn() });

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByLabelText('Tell Bob what to build'), { target: { value: 'Save this request' } });
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), {
    target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_vibe_send_with_attachments_opt_in', expect.anything()));
  messages.push({
    ...message('saved', 1, 'owner', 'message', 'Save this request'),
    payload: { attachments: [{ id: 'a', file_name: 'photo.png', file_type: 'image/png', file_size_bytes: 5, extraction_status: 'pending' }] },
  });
  await act(async () => { resolveSend({ data: 'saved', error: null }); await pending; });
  await waitFor(() => expect((screen.getByLabelText('Tell Bob what to build') as HTMLTextAreaElement).value).toBe(''));
  sessions[0] = { ...sessions[0], status: 'closed' };
  act(() => onSession?.({ new: sessions[0], eventType: 'UPDATE' }));

  fireEvent.click(screen.getByRole('button', { name: 'Show closed sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: /Closing session.*Closed/ }));
  expect(await screen.findByText('Save this request')).toBeTruthy();
  expect(screen.getByText('photo.png')).toBeTruthy();
});

it('keeps sending disabled until every overlapping action has finished', async () => {
  wireRealtime();
  let resolveSend!: (value: { data: null; error: null }) => void;
  const pending = new Promise<{ data: null; error: null }>((resolve) => { resolveSend = resolve; });
  const sessions = [session('a', 'First session')];
  rpc.mockImplementation((name: string) => {
    if (name === 'builder_vibe_send_with_attachments_opt_in') return pending;
    if (name === 'builder_vibe_session_open') {
      sessions.push(session('b', 'New session'));
      return Promise.resolve({ data: 'b', error: null });
    }
    return Promise.resolve({ data: true, error: null });
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.change(await screen.findByLabelText('Tell Bob what to build'), { target: { value: 'First request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  await screen.findByRole('heading', { name: 'New session' });
  fireEvent.change(screen.getByLabelText('Tell Bob what to build'), { target: { value: 'Next request' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Attach screenshot or document' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { resolveSend({ data: null, error: null }); await pending; });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
});

it('does not clear a new session’s attachments when an earlier send finishes', async () => {
  wireRealtime();
  let resolveSend!: (value: { data: null; error: null }) => void;
  const pending = new Promise<{ data: null; error: null }>((resolve) => { resolveSend = resolve; });
  const sessions = [session('a', 'First session')];
  const newer = { ...session('b', 'New session'), last_activity_at: '2026-11-11T00:00:00.000Z' };
  rpc.mockImplementation((name: string) => {
    if (name === 'builder_vibe_send_with_attachments_opt_in') return pending;
    if (name === 'builder_vibe_session_open') {
      sessions.push(newer);
      return Promise.resolve({ data: 'b', error: null });
    }
    return Promise.resolve({ data: true, error: null });
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'First request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  await screen.findByRole('heading', { name: 'New session' });
  expect((screen.getByRole('button', { name: 'Attach screenshot or document' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), {
    target: { files: [new File(['example'], 'new-session.txt', { type: 'text/plain' })] },
  });
  const consent = screen.getByRole('checkbox', { name: /Allow this message/ }) as HTMLInputElement;
  expect(consent.disabled).toBe(true);
  await act(async () => { resolveSend({ data: null, error: null }); await pending; });
  expect(screen.getByText('new-session.txt')).toBeTruthy();
  expect(consent.checked).toBe(false);
  fireEvent.click(consent);
  expect(consent.checked).toBe(true);
});

it('keeps an unsent draft accessible when its session closes elsewhere', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const active = session('s', 'Remote close');
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  const draft = await screen.findByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(draft, { target: { value: 'Keep this draft after remote close' } });
  act(() => onSession?.({ new: { ...active, status: 'closed' }, eventType: 'UPDATE' }));
  const recovered = await screen.findByRole('textbox', { name: 'Unsent draft for Remote close' }) as HTMLTextAreaElement;
  expect(recovered.value).toBe('Keep this draft after remote close');
  expect(recovered.readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
});

it('lets the owner clear staged attachments when their session closes elsewhere', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const active = session('s', 'Remote close');
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active] : []));

  render(<BuilderVibePage />);
  const input = await screen.findByLabelText('Attach screenshots or documents');
  fireEvent.change(input, { target: { files: [new File(['example'], 'draft.txt', { type: 'text/plain' })] } });
  expect(screen.getByText('draft.txt')).toBeTruthy();
  act(() => onSession?.({ new: { ...active, status: 'closed' }, eventType: 'UPDATE' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clear local selection of draft.txt' }));
  expect(screen.queryByText('draft.txt')).toBeNull();
  expect((screen.getByRole('button', { name: 'New' }) as HTMLButtonElement).disabled).toBe(false);
});

it('allows recovery when a registered attachment’s session closes while disconnected', async () => {
  let connection: ((status: string) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: () => sub,
      subscribe: (callback?: (status: string) => void) => {
        if (name === 'builder-vibe-sessions') connection = callback;
        callback?.('SUBSCRIBED');
        return sub;
      },
    };
    return sub;
  });
  const remove = vi.fn().mockResolvedValue({ error: null });
  storageFrom.mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }), remove });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_send_with_attachments_opt_in'
    ? Promise.resolve({ data: null, error: { message: 'Send failed' } })
    : Promise.resolve({ data: true, error: null }));
  const sessions = [session('s', 'Disconnected session')];
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  const input = await screen.findByLabelText('Attach screenshots or documents');
  fireEvent.change(input, { target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Send failed.*may already be saved/);
  act(() => connection?.('CHANNEL_ERROR'));
  sessions[0] = { ...sessions[0], status: 'closed' };
  act(() => connection?.('SUBSCRIBED'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clear local selection of photo.png' }));
  expect(remove).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalledWith('builder_vibe_attachment_delete', expect.anything());
  expect((screen.getByRole('button', { name: 'New' }) as HTMLButtonElement).disabled).toBe(false);
});

it('does not move staged attachments to a different automatically selected session', async () => {
  let onSession: ((change: { new: ReturnType<typeof session>; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: ReturnType<typeof session>; eventType: string }) => void) => {
        if (name === 'builder-vibe-sessions') onSession = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  const active = { ...session('s', 'Remote close'), last_activity_at: '2026-11-11T00:00:00.000Z' };
  const other = session('other', 'Another session');
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [active, other] : []));

  render(<BuilderVibePage />);
  const input = await screen.findByLabelText('Attach screenshots or documents');
  fireEvent.change(input, { target: { files: [new File(['example'], 'private.txt', { type: 'text/plain' })] } });
  act(() => onSession?.({ new: { ...active, status: 'closed' }, eventType: 'UPDATE' }));
  await screen.findByRole('heading', { name: 'Another session' });
  const newDraft = screen.getByRole('textbox', { name: 'Tell Bob what to build' });
  fireEvent.change(newDraft, { target: { value: 'A different request' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Clear local selection of private.txt' }));
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  expect(rpc).not.toHaveBeenCalledWith('builder_vibe_send_with_attachments_opt_in', expect.anything());
});

it('does not change another selection when closing a session completes late', async () => {
  wireRealtime();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  let resolveClose!: (value: { data: null; error: null }) => void;
  const close = new Promise<{ data: null; error: null }>((resolve) => { resolveClose = resolve; });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_session_close' ? close : Promise.resolve({ data: true, error: null }));
  const alpha = session('a', 'Alpha');
  const beta = { ...session('b', 'Beta'), last_activity_at: '2026-11-09T00:00:00.000Z' };
  const gamma = { ...session('c', 'Gamma'), last_activity_at: '2026-11-08T00:00:00.000Z' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [alpha, beta, gamma] : []));

  try {
    render(<BuilderVibePage />);
    await screen.findByRole('heading', { name: 'Alpha' });
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    fireEvent.click(screen.getByRole('button', { name: /Gamma/ }));
    await screen.findByRole('heading', { name: 'Gamma' });
    await act(async () => { resolveClose({ data: null, error: null }); await close; });
    expect(screen.getByRole('heading', { name: 'Gamma' })).toBeTruthy();
  } finally {
    confirm.mockRestore();
  }
});

it('does not open a delayed preview for a different selected session', async () => {
  wireRealtime();
  let finishTicket!: (result: { data: string; error: null }) => void;
  const ticket = new Promise<{ data: string; error: null }>(resolve => { finishTicket = resolve; });
  rpc.mockImplementation((name: string) => name === 'builder_vibe_preview_ticket'
    ? ticket : Promise.resolve({ data: true, error: null }));
  const alpha = { ...session('a', 'Alpha'), preview_requested: true, preview_status: 'ready' };
  const beta = { ...session('b', 'Beta'), preview_requested: true, preview_status: 'ready', last_activity_at: '2026-11-09T00:00:00.000Z' };
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? [alpha, beta] : []));

  render(<BuilderVibePage />);
  await screen.findByRole('heading', { name: 'Alpha' });
  fireEvent.click(screen.getByRole('button', { name: 'Show here' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
  await screen.findByRole('heading', { name: 'Beta' });
  await act(async () => finishTicket({ data: 'ticket-for-alpha', error: null }));
  expect(screen.queryByTitle('Preview of Beta')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show here' })).toBeTruthy();
});

it('shows a late-committing insert even if its sequence is older than the loaded page', async () => {
  let onMessage: ((change: { new: VibeMessage; eventType: string }) => void) | undefined;
  channel.mockImplementation((name: string) => {
    const sub = {
      on: (_event: string, _filter: unknown, listener: (change: { new: VibeMessage; eventType: string }) => void) => {
        if (name === 'builder-vibe-s') onMessage = listener;
        return sub;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.('SUBSCRIBED'); return sub; },
    };
    return sub;
  });
  rpc.mockResolvedValue({ data: true, error: null });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions'
    ? [session('s', 'Late insert')] : [{ ...message('m101', 101, 'bob', 'message', 'Message 101') }]));

  render(<BuilderVibePage />);
  await screen.findByText('Message 101');
  act(() => onMessage?.({ new: message('m100', 100, 'bob', 'message', 'Message 100'), eventType: 'INSERT' }));
  expect(screen.getByText('Message 100')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
});

it('keeps the visible conversation and offers retry when an older page fails', async () => {
  wireRealtime();
  rpc.mockResolvedValue({ data: true, error: null });
  let failOlderPage = true;
  const messages = Array.from({ length: 101 }, (_, index) =>
    ({ ...message(`m${index + 1}`, index + 1, 'bob', 'message', `Message ${index + 1}`) }));
  from.mockImplementation((table: string) => {
    const result = pagedQuery(table === 'builder_vibe_sessions' ? [session('s', 'Retry session')] : messages);
    let older = false;
    const lt = result.lt;
    const limit = result.limit;
    result.lt = (field, value) => { older = true; lt(field, value); return result; };
    result.limit = async (count) => {
      if (older && failOlderPage) {
        failOlderPage = false;
        return { data: null, error: { message: 'History temporarily unavailable' } };
      }
      return limit(count);
    };
    return result;
  });

  render(<BuilderVibePage />);
  await screen.findByText('Message 101');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByRole('alert');
  expect(screen.getByText('History temporarily unavailable')).toBeTruthy();
  expect(screen.getByText('Message 101')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 1');
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

it('confirms the stored reference after opening a Vibe session', async () => {
  wireRealtime();
  const sessions: Array<Record<string, unknown>> = [];
  rpc.mockImplementation(async (name: string) => {
    if (name === 'builder_vibe_session_open') {
      sessions.push({ ...session('new-session', 'Untitled vibe session'), created_by: 'owner-id', human_reference: 'VB-112' });
      return { data: 'new-session', error: null };
    }
    return { data: true, error: null };
  });
  from.mockImplementation((table: string) => pagedQuery(table === 'builder_vibe_sessions' ? sessions : []));

  render(<BuilderVibePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'New' }));
  expect(await screen.findByText('Started VB-112.')).toBeTruthy();
  expect(screen.getByText('Reference: VB-112')).toBeTruthy();
});

it.each([false, true])('uploads privately and records per-message attachment cloud consent %s', async (allowCloud) => {
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
  const consent = screen.getByRole('checkbox', { name: /Allow this message/ });
  expect((consent as HTMLInputElement).checked).toBe(false);
  if (allowCloud) fireEvent.click(consent);
  fireEvent.change(input, { target: { value: 'Please investigate this error' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(rpc).toHaveBeenCalledWith('builder_vibe_send_with_attachments_opt_in', expect.objectContaining({
    p_session_id: sessionId,
    p_content: 'Please investigate this error',
    p_attachment_ids: [expect.any(String)],
    p_allow_ollama_cloud: allowCloud,
  })));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Allow this message/ })).toBeNull());
  expect((input as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), { target: { files: [file] } });
  expect((screen.getByRole('checkbox', { name: /Allow this message/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow this message/ }));
  fireEvent.change(screen.getByLabelText('Attach screenshots or documents'), { target: { files: [new File(['extra'], 'extra.txt', { type: 'text/plain' })] } });
  expect((screen.getByRole('checkbox', { name: /Allow this message/ }) as HTMLInputElement).checked).toBe(false);
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
