import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BobPanel } from './BobPanel';
import { extractMermaidDiagrams } from './BobStudio';

const { mockFrom, mockInvoke, mockRpc, mockStorageFrom } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn(),
  mockRpc: vi.fn(),
  mockStorageFrom: vi.fn(),
}));
let messageHistory: Array<Record<string, unknown>> = [];
let attachmentHistory: Array<Record<string, unknown>> = [];
let conversationList: Array<Record<string, unknown>> = [];
let auditHistory: Array<Record<string, unknown>> = [];
let governedActionHistory: Array<Record<string, unknown>> = [];
let turnRunHistory: Array<Record<string, unknown>> = [];
let perceptionEnvelopeHistory: Array<Record<string, unknown>> = [];
let perceptionFieldHistory: Array<Record<string, unknown>> = [];
let feedbackHistory: Array<Record<string, unknown>> = [];
let feedbackLoadFailure = false;
let profileRole = 'grand_master';
let profileOrganizationId = 'org-1';

function fixtureSession(row: Record<string, unknown>, index: number) {
  return {
    id: typeof row.id === 'string' ? row.id : `fixture-${index}`,
    title: typeof row.title === 'string' ? row.title : null,
    human_reference: `BOB-${index + 1}`,
    organization_id: 'org-1',
    user_id: 'user-1',
    module_key: 'operations',
    pinned: false,
    archived_at: null,
    created_at: '2026-09-02T05:00:00.000Z',
    updated_at: '2026-09-02T06:00:00.000Z',
    ...row,
  };
}

async function fixtureRpc(name: string, args: Record<string, unknown> = {}) {
  if (name === 'bob_list_conversations') {
    const term = String(args.p_search ?? '').trim().toLowerCase();
    const results = conversationList.map(fixtureSession).filter(row =>
      row.organization_id === args.p_organization_id &&
      row.user_id === 'user-1' &&
      row.module_key === args.p_module_key &&
      (args.p_filter === 'archived' ? row.archived_at !== null
        : row.archived_at === null && (args.p_filter !== 'pinned' || row.pinned)) &&
      (!term || String(row.title ?? '').toLowerCase().includes(term) || String(row.human_reference).toLowerCase().includes(term)) &&
      (!args.p_cursor_updated_at || String(row.updated_at) < String(args.p_cursor_updated_at)
        || (row.updated_at === args.p_cursor_updated_at && String(row.id) < String(args.p_cursor_id)))
    ).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)));
    return { data: results.slice(0, Number(args.p_page_size) + 1), error: null };
  }
  if (name === 'bob_rename_conversation') {
    const index = conversationList.findIndex(row => row.id === args.p_conversation_id);
    if (index < 0) return { data: null, error: { message: 'Conversation unavailable.' } };
    const row = fixtureSession(conversationList[index], index);
    if (row.title !== args.p_expected_title) return { data: null, error: { message: 'Title changed; refresh before saving.' } };
    conversationList[index] = { ...row, title: args.p_title, updated_at: '2030-01-01T00:00:00.000Z' };
    return { data: conversationList[index], error: null };
  }
  return { data: null, error: null };
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', organizationId: profileOrganizationId, role: profileRole },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    functions: { invoke: mockInvoke },
    storage: { from: mockStorageFrom },
  },
}));

describe('BobPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setViewport = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  };

  beforeEach(() => {
    mockFrom.mockReset();
    mockInvoke.mockReset();
    mockRpc.mockReset();
    mockStorageFrom.mockReset();
    messageHistory = [];
    attachmentHistory = [];
    conversationList = [];
    auditHistory = [];
    governedActionHistory = [];
    turnRunHistory = [];
    perceptionEnvelopeHistory = [];
    perceptionFieldHistory = [];
    feedbackHistory = [];
    feedbackLoadFailure = false;
    profileRole = 'grand_master';
    profileOrganizationId = 'org-1';

    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        let limit = 100;
        const filters: Record<string, unknown> = {};
        const query = {
          eq: (column: string, value: unknown) => { filters[column] = value; return query; },
          order: () => query,
          limit: (value: number) => { limit = value; return query; },
          maybeSingle: async () => {
            const rows = conversationList.map(fixtureSession);
            const selected = filters.id ? rows.find(row => row.id === filters.id) : rows[0];
            const implicit = !rows.length && (!filters.id || filters.id === 'conversation-1')
              ? fixtureSession({ id: 'conversation-1', title: 'Bob Operations' }, 0) : null;
            return { data: selected ?? implicit, error: null };
          },
          then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
            resolve({ data: conversationList.slice(0, limit).map(fixtureSession), error: null }),
        };
        return {
          select: () => query,
          insert: (rows: Array<Record<string, unknown>>) => ({
            select: () => ({
              single: async () => {
                const created = fixtureSession({ ...rows[0], id: `conversation-${conversationList.length + 2}` }, conversationList.length + 1);
                conversationList.unshift(created);
                return { data: created, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }

      if (table === 'bob_messages') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: messageHistory, error: null }),
            }),
          }),
        };
      }

      if (table === 'bob_message_feedback') {
        const feedbackQuery = {
          eq: () => feedbackQuery,
          then: (resolve: (value: { data: unknown; error: { message: string } | null }) => unknown) => resolve(
            feedbackLoadFailure
              ? { data: null, error: { message: 'feedback unavailable' } }
              : { data: feedbackHistory, error: null }
          ),
        };
        return { select: () => feedbackQuery };
      }

      if (table === 'bob_attachments') {
        const attachmentQuery = {
          eq: () => ({
            order: async () => ({ data: attachmentHistory, error: null }),
          }),
        };
        return {
          select: () => attachmentQuery,
          insert: vi.fn().mockImplementation(async (rows: Array<Record<string, unknown>>) => {
            attachmentHistory.push(...rows.map(row => ({
              ...row,
              extraction_summary: null,
              confidence: null,
              created_at: '2026-09-02T06:00:00.000Z',
            })));
            return { error: null };
          }),
        };
      }

      if (table === 'bob_event_log') {
        const auditQuery = {
          eq: () => auditQuery,
          order: () => auditQuery,
          limit: async () => ({ data: auditHistory, error: null }),
        };
        return { select: () => auditQuery };
      }

      if (table === 'bob_agentic_actions') {
        const actionQuery = {
          eq: () => actionQuery,
          order: () => actionQuery,
          limit: async () => ({ data: governedActionHistory, error: null }),
        };
        return { select: () => actionQuery };
      }

      if (table === 'bob_turn_runs') {
        const runQuery = {
          eq: () => runQuery,
          in: () => runQuery,
          order: () => runQuery,
          limit: async () => ({ data: turnRunHistory, error: null }),
        };
        return { select: () => runQuery };
      }

      if (table === 'perception_evidence_envelopes') {
        const envelopeQuery = {
          in: () => envelopeQuery,
          eq: async () => ({ data: perceptionEnvelopeHistory, error: null }),
        };
        return { select: () => envelopeQuery };
      }

      if (table === 'perception_evidence_fields') {
        return {
          select: () => ({
            in: async () => ({ data: perceptionFieldHistory, error: null }),
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
      };
    });

    mockInvoke.mockResolvedValue({ data: { reply: 'ok' }, error: null });
    mockRpc.mockImplementation(fixtureRpc);
    mockStorageFrom.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/bob-media.jpg' }, error: null }),
    });
  });

  it('passes the live relationship context to Bob when sending a message', async () => {
    render(
      <BobPanel
        open
        onClose={() => undefined}
        context={{
          page: 'approvals',
          pagePath: '/admin/approvals',
          actionId: 'action-1',
          agreement: { id: 'agreement-1', name: 'Site Service Agreement' },
          site: { id: 'site-1', name: 'North Plant' },
          zone: { id: 'zone-1', name: 'Zone A' },
        }}
      />
    );

    await waitFor(() => {
      expect(mockFrom).toHaveBeenCalledWith('bob_conversations');
    });
    expect(mockFrom).toHaveBeenCalledWith('bob_conversations');

    expect(screen.getByText('Governed session')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan work' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Check the site status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', {
        body: {
          operation: 'enqueue',
          message: 'Check the site status',
          conversation_id: 'conversation-1',
          request_id: expect.any(String),
          attachments: [],
          context: {
            page: 'approvals',
            pagePath: '/admin/approvals',
            actionId: 'action-1',
            agreement: { id: 'agreement-1', name: 'Site Service Agreement' },
            site: { id: 'site-1', name: 'North Plant' },
            zone: { id: 'zone-1', name: 'Zone A' },
            agent_mode: 'operations',
            visible_page: { path: '/', headings: [], controls: [] },
          },
        },
      });
    });
  });

  it('keeps the newest Bob reply in view when the canonical thread refreshes', async () => {
    messageHistory = [{
      id: 'old-reply', role: 'assistant', content: 'Earlier response', confidence: null,
      flagged: false, created_at: '2026-10-16T09:00:00.000Z', metadata: {},
    }];
    render(<BobPanel open presentation="docked" onClose={() => undefined} />);

    expect(await screen.findByText('Earlier response')).toBeTruthy();
    const stream = document.querySelector('.bob-message-stream') as HTMLDivElement;
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 1200 });
    stream.scrollTop = 0;
    messageHistory = [
      ...messageHistory,
      { id: 'new-request', role: 'user', content: 'Continue the work', confidence: null, flagged: false, created_at: '2026-10-16T09:01:00.000Z', metadata: {} },
      { id: 'new-reply', role: 'assistant', content: 'The latest response', confidence: null, flagged: false, created_at: '2026-10-16T09:02:00.000Z', metadata: {} },
    ];
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Continue the work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('The latest response')).toBeTruthy();
    await waitFor(() => expect(stream.scrollTop).toBe(stream.scrollHeight));
  });

  it('opens the field-portal Bob as a simple full-screen dialog', async () => {
    const onClose = vi.fn();
    messageHistory = [{
      id: 'fs-reply', role: 'assistant', content: 'Field answer', confidence: 0.9,
      flagged: false, created_at: '2026-11-06T09:00:00.000Z',
      metadata: { planned_tool: 'repo_search', suggested_action: 'Check the site instruction.' },
    }];
    render(<BobPanel open presentation="fullscreen" onClose={onClose} context={{ shift_id: 'shift-1' }} />);

    const dialog = await screen.findByRole('dialog', { name: 'Bob assistant' });
    expect(dialog.className).toContain('is-fullscreen');
    expect(dialog.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    expect(await screen.findByText('Field answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sessions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /context panel/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /document studio/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /full workspace/i })).toBeNull();
    expect(screen.queryByLabelText('Active context')).toBeNull();
    expect(screen.queryByText('Was this useful?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the field portal' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders safe agent plan metadata from the server-persisted conversation', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', content: 'I found a safe next step.', confidence: 0.8,
      flagged: false, created_at: '2026-09-02T06:00:00.000Z',
      metadata: { planned_tool: 'repo_search', suggested_action: 'Review the affected files before proposing a change.' },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('repo search')).toBeTruthy();
    expect(screen.getByText('Response confidence 80%')).toBeTruthy();
    expect(screen.getByText('Review the affected files before proposing a change.')).toBeTruthy();
  });

  it('reads back the current user feedback for an assistant reply', async () => {
    messageHistory = [{
      id: 'message-feedback', role: 'assistant', content: 'The branch exception is ready for review.', confidence: null,
      flagged: false, created_at: '2026-10-16T08:00:00.000Z', metadata: {},
    }];
    feedbackHistory = [{
      id: 'feedback-1', message_id: 'message-feedback', rating: 'up', note: null, updated_at: '2026-10-16T08:01:00.000Z',
    }];

    render(<BobPanel open onClose={() => undefined} />);

    const helpful = await screen.findByRole('button', { name: 'Helpful' });
    expect(helpful.getAttribute('aria-pressed')).toBe('true');
    expect(mockFrom).toHaveBeenCalledWith('bob_message_feedback');
  });

  it('keeps Bob chat available when saved feedback cannot be loaded', async () => {
    messageHistory = [{
      id: 'message-feedback', role: 'assistant', content: 'The operational answer remains visible.', confidence: null,
      flagged: false, created_at: '2026-10-16T08:00:00.000Z', metadata: {},
    }];
    feedbackLoadFailure = true;

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('The operational answer remains visible.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Saved reply feedback could not be loaded. Bob chat remains available.');
  });

  it('saves improvement feedback through the governed command and shows the persisted receipt', async () => {
    messageHistory = [{
      id: 'message-feedback', role: 'assistant', content: 'The branch exception is ready for review.', confidence: null,
      flagged: false, created_at: '2026-10-16T08:00:00.000Z', metadata: {},
    }];
    mockRpc.mockImplementation(async (name: string) => name === 'manage_bob_message_feedback'
      ? {
        data: {
          id: 'feedback-1',
          message_id: 'message-feedback',
          rating: 'down',
          note: 'Show the selected operating branch.',
          updated_at: '2026-10-16T08:02:00.000Z',
        },
        error: null,
      }
      : { data: null, error: null });

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Needs improvement' }));
    fireEvent.change(screen.getByLabelText(/What should Bob improve/), {
      target: { value: 'Show the selected operating branch.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('manage_bob_message_feedback', {
        p_message_id: 'message-feedback',
        p_rating: 'down',
        p_note: 'Show the selected operating branch.',
      });
    });
    expect(await screen.findByText('Improvement feedback saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Needs improvement' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('renders selectable recovery choices and a safe pre-seeded destination for blocked work', async () => {
    messageHistory = [{
      id: 'message-blocked',
      role: 'assistant',
      content: 'The laptop inventory requires owner access.',
      confidence: null,
      flagged: false,
      created_at: '2026-10-11T06:00:00.000Z',
      metadata: {
        intent: 'effect_blocked_by_conductor',
        answer_options: ['Use attached files instead', 'Explain the required owner access'],
        navigation_actions: [{ label: 'Open document studio', path: '/admin/document-studio?sourceType=company&sourceId=org-1' }],
      },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByRole('button', { name: 'Use attached files instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Explain the required owner access' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open document studio' }).getAttribute('href')).toBe('/admin/document-studio?sourceType=company&sourceId=org-1');
  });

  it('shows a persistent guided workflow and exact approval destination for governed writes', async () => {
    messageHistory = [{
      id: 'message-proposal',
      role: 'assistant',
      content: 'I prepared the reversible change for review.',
      confidence: 0.9,
      flagged: false,
      created_at: '2026-10-11T06:00:00.000Z',
      metadata: {
        action_id: '11111111-1111-4111-8111-111111111111',
        workflow_steps: [
          { id: 'prepared', label: 'Proposal prepared', status: 'completed', detail: 'Bob recorded the proposed change.' },
          { id: 'review', label: 'Human review', status: 'current', detail: 'Inspect and decide.' },
          { id: 'apply', label: 'Apply and verify', status: 'pending', detail: 'Write through the governed executor.' },
        ],
        navigation_actions: [{
          label: 'Review and apply proposal',
          path: '/admin/approvals?actionId=11111111-1111-4111-8111-111111111111&source=bob',
        }],
      },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByRole('region', { name: 'Bob workflow progress' })).toBeTruthy();
    expect(screen.getByText('Proposal prepared')).toBeTruthy();
    expect(screen.getByText('Human review')).toBeTruthy();
    expect(screen.getByText('Apply and verify')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review and apply proposal' }).getAttribute('href'))
      .toBe('/admin/approvals?actionId=11111111-1111-4111-8111-111111111111&source=bob');
  });

  it('distinguishes a superseded reply from its append-only audit correction', async () => {
    messageHistory = [
      {
        id: 'message-incorrect',
        role: 'assistant',
        content: 'Plate: 11739',
        confidence: 1,
        flagged: true,
        created_at: '2026-10-11T04:00:00.000Z',
        metadata: { superseded_by_message_id: 'message-correction' },
      },
      {
        id: 'message-correction',
        role: 'assistant',
        content: 'Correction: Plate JJJ739',
        confidence: null,
        flagged: false,
        created_at: '2026-10-11T04:01:00.000Z',
        metadata: { outcome: 'correction', correction_of_message_id: 'message-incorrect' },
      },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Superseded by correction')).toBeTruthy();
    expect(screen.getByText('Audit correction')).toBeTruthy();
    expect(screen.getByText(/Plate: 11739/)).toBeTruthy();
    expect(screen.getByText(/Correction: Plate JJJ739/)).toBeTruthy();
  });

  it('restores an active durable turn when the conversation is reopened', async () => {
    let resolveStatus: (value: { data: { turn_run: Record<string, unknown> }; error: null }) => void = () => undefined;
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) => {
      if (options?.body?.operation === 'status') {
        return new Promise(resolve => { resolveStatus = resolve; });
      }
      return Promise.resolve({ data: null, error: null });
    });
    turnRunHistory = [{
      request_id: '12345678-1234-4234-8234-123456789abc',
      status: 'running',
      started_at: '2026-10-11T04:00:00.000Z',
      heartbeat_at: '2026-10-11T04:00:04.000Z',
      completed_at: null,
      error_code: null,
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('running')).toBeTruthy();
    expect(screen.getByText(/Request 12345678/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy();

    messageHistory = [{
      id: 'message-restored',
      role: 'assistant',
      content: 'Restored durable reply',
      confidence: 0.9,
      flagged: false,
      created_at: '2026-10-11T04:00:08.000Z',
      metadata: {},
    }];
    await act(async () => {
      resolveStatus({
        data: {
          turn_run: {
            ...turnRunHistory[0],
            status: 'completed',
            heartbeat_at: '2026-10-11T04:00:08.000Z',
            completed_at: '2026-10-11T04:00:08.000Z',
          },
        },
        error: null,
      });
    });

    expect(await screen.findByText('Restored durable reply')).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ operation: 'status', request_id: '12345678-1234-4234-8234-123456789abc' }),
    }));
    expect(mockInvoke).not.toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ operation: 'enqueue' }),
    }));
  });

  it('answers a clarifying question by clicking a supplied option instead of retyping it', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', content: 'Which organisation is this capability statement for?', confidence: 0.6,
      flagged: false, created_at: '2026-09-02T06:00:00.000Z',
      metadata: { intent: 'clarifying_questions', answer_options: ['R & M Security and Investigation', 'R&M Other Private Clients'] },
    }];
    mockInvoke.mockResolvedValue({ data: { reply: 'ok' }, error: null });

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'R & M Security and Investigation' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
        body: expect.objectContaining({ message: 'R & M Security and Investigation' }),
      }));
    });
  });

  it('offers Bob\'s best guess as a clickable answer when no options are supplied', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', content: 'Should I use the 2026 rate card?', confidence: 0.6,
      flagged: false, created_at: '2026-09-02T06:00:00.000Z',
      metadata: { intent: 'clarifying_questions', best_guess: 'Yes, use the 2026 rate card' },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByRole('button', { name: 'Yes, use the 2026 rate card' })).toBeTruthy();
  });

  it('offers recommended Continue/Pause choices for persisted budget pauses', async () => {
    messageHistory = [{
      id: 'paused', role: 'assistant', content: 'Shall I continue from where I left off?',
      metadata: { continuation_pending: true },
      created_at: '2026-10-16T09:00:00Z',
    }];
    render(<BobPanel open presentation="docked" onClose={() => undefined} />);
    const proceed = await screen.findByRole('button', { name: 'Continue from where you left off' });
    expect(proceed.getAttribute('aria-description')).toBe('Recommended by Bob');
    expect(screen.getByRole('button', { name: 'Pause here; wait for my next instruction' })).toBeTruthy();
    fireEvent.click(proceed);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ operation: 'enqueue', message: 'Continue from where you left off' }),
    })));
  });

  it('preserves a typed override instead of letting a suggestion replace it', async () => {
    messageHistory = [{
      id: 'question', role: 'assistant', content: 'Which plan?',
      metadata: { answer_options: ['Plan A', 'Plan B'], recommended_answer: 'Plan A' },
      created_at: '2026-10-16T09:00:00Z',
    }];
    render(<BobPanel open presentation="docked" onClose={() => undefined} />);
    const option = await screen.findByRole('button', { name: 'Plan A' });
    const composer = screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal');
    fireEvent.change(composer, { target: { value: 'Use Plan B but keep the current rates' } });
    expect(option).toHaveProperty('disabled', true);
    fireEvent.click(option);
    expect(mockInvoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ message: 'Use Plan B but keep the current rates' }),
    })));
  });

  it('disables historical choices and choices during a durable request', async () => {
    messageHistory = [
      { id: 'old', role: 'assistant', content: 'Old question', metadata: { answer_options: ['Old answer'] }, created_at: '2026-10-16T09:00:00Z' },
      { id: 'answer', role: 'user', content: 'Already answered', metadata: {}, created_at: '2026-10-16T09:01:00Z' },
      { id: 'new', role: 'assistant', content: 'New question', metadata: { answer_options: ['New answer'] }, created_at: '2026-10-16T09:02:00Z' },
    ];
    turnRunHistory = [{ request_id: 'pending', status: 'running', started_at: '2026-10-16T09:03:00Z', heartbeat_at: '2026-10-16T09:03:00Z' }];
    render(<BobPanel open presentation="docked" onClose={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Old answer' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New answer' })).toHaveProperty('disabled', true));
  });

  it('keeps the operations dock non-modal and Studio reachable', async () => {
    render(<><button type="button">Working page action</button><BobPanel open presentation="docked" onClose={() => undefined} /></>);
    const panel = await screen.findByRole('complementary', { name: 'Bob agent workspace' });
    expect(panel.getAttribute('aria-modal')).toBeNull();
    const pageAction = screen.getByRole('button', { name: 'Working page action' });
    pageAction.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(pageAction);
    fireEvent.click(screen.getByRole('button', { name: 'Open document studio' }));
    expect(await screen.findByLabelText('Bob studio')).toBeTruthy();
  });

  it('renders Bob headings, bold text, and lists as structured elements', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', flagged: false, confidence: null,
      created_at: '2026-09-02T06:00:00.000Z',
      content: '### Findings\n\nThe build is **partway** to enterprise-grade.\n\n- First risk\n- Second risk\n\n1. Fix state clarity\n2. Add evidence intake',
      metadata: {},
    }];

    render(<BobPanel open onClose={() => undefined} />);

    const heading = await screen.findByRole('heading', { name: 'Findings' });
    expect(heading.tagName).toBe('H4');
    expect(screen.getByText('partway').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getAllByRole('list')).toHaveLength(2);
  });

  it('renders Bob links and code spans safely, and blocks unsafe hrefs', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', flagged: false, confidence: null,
      created_at: '2026-09-02T06:00:00.000Z',
      content: 'Run `npm test` then see [the source](https://example.com/docs) or [bad link](javascript:alert(1)).',
      metadata: {},
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('npm test')).toHaveProperty('tagName', 'CODE');
    const link = screen.getByRole('link', { name: 'the source' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('link', { name: 'bad link' })).toBeNull();
    expect(screen.getByText(/bad link/)).toBeTruthy();
  });

  it('uploads attached evidence through bob-uploads and registers bob_attachments', async () => {
    const storageApi = { upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn().mockResolvedValue({ error: null }) };
    mockStorageFrom.mockReturnValue(storageApi);

    render(<BobPanel open onClose={() => undefined} />);

    const file = new File(['site evidence'], 'evidence.txt', { type: 'text/plain' });
    fireEvent.change(await screen.findByLabelText('Attach evidence files'), { target: { files: [file] } });

    expect(await screen.findByText('evidence.txt')).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockStorageFrom).toHaveBeenCalledWith('bob-uploads');
      expect(storageApi.upload).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledWith('bob_attachments');
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
        body: expect.objectContaining({
          message: 'Please review the attached file(s).',
          attachments: [expect.objectContaining({ name: 'evidence.txt', storage_bucket: 'bob-uploads' })],
        }),
      }));
    });
  });

  it('shows a named Bob working timeline while a request is in flight', async () => {
    let resolveInvoke: (value: { data: { reply: string }; error: null }) => void = () => undefined;
    mockInvoke.mockReturnValue(new Promise(resolve => { resolveInvoke = resolve; }));

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.change(await screen.findByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Check live operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Bob is working')).toBeTruthy();
    expect(screen.getByText('Preparing request')).toBeTruthy();
    expect(screen.getByText('Waiting for Bob')).toBeTruthy();

    resolveInvoke({ data: { reply: 'done' }, error: null });
  });

  it('queues a turn and automatically replaces it with the durable reply', async () => {
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) => {
      const operation = options?.body?.operation;
      if (operation === 'enqueue') {
        return Promise.resolve({
          data: {
            accepted: true,
            turn_run: {
              request_id: options?.body?.request_id,
              status: 'queued',
              started_at: '2026-10-11T04:00:00.000Z',
              heartbeat_at: '2026-10-11T04:00:00.000Z',
              completed_at: null,
              error_code: null,
            },
          },
          error: null,
        });
      }
      if (operation === 'status') {
        messageHistory = [{
          id: 'message-durable',
          role: 'assistant',
          content: 'Durable reply ready',
          confidence: 0.9,
          flagged: false,
          created_at: '2026-10-11T04:00:04.000Z',
          metadata: {},
        }];
        return Promise.resolve({
          data: {
            turn_run: {
              request_id: options?.body?.request_id,
              status: 'completed',
              started_at: '2026-10-11T04:00:00.000Z',
              heartbeat_at: '2026-10-11T04:00:04.000Z',
              completed_at: '2026-10-11T04:00:04.000Z',
              error_code: null,
            },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.change(await screen.findByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Check the durable queue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Durable reply ready')).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ operation: 'enqueue' }),
    }));
    expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({ operation: 'status' }),
    }));
  });

  it('keeps new attachments staged when an earlier queued turn completes', async () => {
    let finishStatus!: (result: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
    const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
    let requestId = '';
    const storageApi = { upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn().mockResolvedValue({ error: null }) };
    mockStorageFrom.mockReturnValue(storageApi);
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      requestId = String(options?.body?.request_id);
      if (options?.body?.operation === 'status') return statusResult;
      return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    const fileInput = await screen.findByLabelText('Attach evidence files');
    fireEvent.change(fileInput, { target: { files: [new File(['first'], 'submitted.txt', { type: 'text/plain' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(requestId).not.toBe(''));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files' })).toHaveProperty('disabled', false));

    fireEvent.change(fileInput, { target: { files: [new File(['next'], 'next-draft.txt', { type: 'text/plain' })] } });
    messageHistory = [{
      id: 'completed-answer', role: 'assistant', content: 'First request completed.',
      confidence: null, flagged: false, created_at: '2026-11-10T00:00:01.000Z', metadata: {},
    }];
    await act(async () => {
      finishStatus({ data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
      await statusResult;
    });

    await screen.findByText('First request completed.');
    const tray = screen.getByLabelText('Attached files');
    expect(within(tray).getByText('next-draft.txt')).toBeTruthy();
    expect(within(tray).queryByText('submitted.txt')).toBeNull();
  });

  it('keeps the thread on the latest reply after a queued turn completes', async () => {
    const scrollPositions = new WeakMap<Element, number>();
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const topDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.querySelectorAll('article').length * 100; },
    });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) { return scrollPositions.get(this) ?? 0; },
      set(this: Element, value: number) { scrollPositions.set(this, value); },
    });
    try {
      let finishStatus!: (result: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
      const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
      let requestId = '';
      mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
        if (name !== 'onspace-ai-chat') return { data: null, error: null };
        requestId = String(options?.body?.request_id);
        if (options?.body?.operation === 'status') return statusResult;
        return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
      });

      const { container } = render(<BobPanel open onClose={() => undefined} />);
      fireEvent.change(await screen.findByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Summarise the night shift.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(requestId).not.toBe(''));

      messageHistory = [
        { id: 'question', role: 'user', content: 'Summarise the night shift.', confidence: null, flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {} },
        { id: 'answer', role: 'assistant', content: 'Night shift summary ready.', confidence: null, flagged: false, created_at: '2026-11-10T00:00:01.000Z', metadata: {} },
      ];
      finishStatus({ data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });

      await screen.findByText('Night shift summary ready.');
      const stream = container.ownerDocument.querySelector('.bob-message-stream') as HTMLElement;
      await waitFor(() => expect(stream.scrollTop).toBe(stream.scrollHeight));
      expect(stream.scrollHeight).toBeGreaterThan(0);
    } finally {
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', heightDescriptor);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (topDescriptor) Object.defineProperty(Element.prototype, 'scrollTop', topDescriptor);
      else delete (Element.prototype as { scrollTop?: number }).scrollTop;
    }
  });

  it('remembers submitted attachments when the current running conversation is reopened', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Review reports', human_reference: 'BOB-1' }];
    let finishStatus!: (result: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
    const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
    let requestId = '';
    const storageApi = { upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn().mockResolvedValue({ error: null }) };
    mockStorageFrom.mockReturnValue(storageApi);
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      requestId = String(options?.body?.request_id);
      if (options?.body?.operation === 'status') return statusResult;
      turnRunHistory = [{ request_id: requestId, status: 'running', started_at: '2026-11-10T00:00:00.000Z' }];
      return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    const fileInput = await screen.findByLabelText('Attach evidence files');
    fireEvent.change(fileInput, { target: { files: [new File(['first'], 'sent-before-reopen.txt', { type: 'text/plain' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(requestId).not.toBe(''));
    const currentSession = await screen.findByRole('button', { name: /Review reports.*BOB-1/ });
    await waitFor(() => expect(currentSession).toHaveProperty('disabled', false));
    fireEvent.click(currentSession);
    await waitFor(() => expect(screen.getByText('running')).toBeTruthy());
    fireEvent.change(fileInput, { target: { files: [new File(['next'], 'draft-after-reopen.txt', { type: 'text/plain' })] } });
    messageHistory = [{
      id: 'completed-answer', role: 'assistant', content: 'Reopened request completed.',
      confidence: null, flagged: false, created_at: '2026-11-10T00:00:01.000Z', metadata: {},
    }];
    turnRunHistory = [];
    await act(async () => {
      finishStatus({ data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
      await statusResult;
    });

    await screen.findByText('Reopened request completed.');
    const tray = screen.getByLabelText('Attached files');
    expect(within(tray).getByText('draft-after-reopen.txt')).toBeTruthy();
    expect(within(tray).queryByText('sent-before-reopen.txt')).toBeNull();
  });

  it('keeps attachments staged after reopening a conversation with a running turn', async () => {
    let finishStatus!: (result: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
    const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
    const requestId = '12345678-1234-4234-8234-123456789abc';
    turnRunHistory = [{ request_id: requestId, status: 'running', started_at: '2026-11-10T00:00:00.000Z' }];
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) =>
      options?.body?.operation === 'status' ? statusResult : Promise.resolve({ data: null, error: null }));

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByText('running');
    fireEvent.change(screen.getByLabelText('Attach evidence files'), {
      target: { files: [new File(['draft'], 'restored-draft.txt', { type: 'text/plain' })] },
    });
    messageHistory = [{
      id: 'completed-answer', role: 'assistant', content: 'Restored request completed.',
      confidence: null, flagged: false, created_at: '2026-11-10T00:00:01.000Z', metadata: {},
    }];
    turnRunHistory = [];
    await act(async () => {
      finishStatus({ data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
      await statusResult;
    });

    await screen.findByText('Restored request completed.');
    expect(within(screen.getByLabelText('Attached files')).getByText('restored-draft.txt')).toBeTruthy();
  });

  it('keeps staged attachments when the user manually checks a completed request', async () => {
    const requestId = '12345678-1234-4234-8234-123456789abc';
    turnRunHistory = [{ request_id: requestId, status: 'running', started_at: '2026-11-10T00:00:00.000Z' }];
    let statusCalls = 0;
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) => {
      if (options?.body?.operation !== 'status') return Promise.resolve({ data: null, error: null });
      statusCalls += 1;
      if (statusCalls === 1) return new Promise(() => undefined);
      turnRunHistory = [];
      messageHistory = [{
        id: 'completed-answer', role: 'assistant', content: 'Manually checked request completed.',
        confidence: null, flagged: false, created_at: '2026-11-10T00:00:01.000Z', metadata: {},
      }];
      return Promise.resolve({ data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByText('running');
    await waitFor(() => expect(statusCalls).toBe(1));
    fireEvent.change(screen.getByLabelText('Attach evidence files'), {
      target: { files: [new File(['draft'], 'manual-check-draft.txt', { type: 'text/plain' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));

    await screen.findByText('Manually checked request completed.');
    expect(within(screen.getByLabelText('Attached files')).getByText('manual-check-draft.txt')).toBeTruthy();
  });

  it('unlocks an undelivered turn only after the server confirms it has no record, without offering a resend', async () => {
    let enqueueCalls = 0;
    const enqueuedRequestIds: unknown[] = [];
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) => {
      const operation = options?.body?.operation;
      if (operation === 'enqueue') {
        enqueueCalls += 1;
        enqueuedRequestIds.push(options?.body?.request_id);
        if (enqueueCalls === 1) {
          return Promise.resolve({ data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { context: undefined }) });
        }
        return Promise.resolve({
          data: {
            turn_run: {
              request_id: options?.body?.request_id,
              status: 'queued',
              started_at: '2026-10-15T06:40:00.000Z',
              heartbeat_at: '2026-10-15T06:40:00.000Z',
              completed_at: null,
              error_code: null,
            },
          },
          error: null,
        });
      }
      if (operation === 'status') {
        if (enqueueCalls === 1) {
          return Promise.resolve({ data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: new Response(null, { status: 404 }) }) });
        }
        return new Promise(() => undefined);
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.change(await screen.findByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Redesign the Builder studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Not delivered')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Bob has no record of this request');
    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore prompt' })).toBeTruthy();

    expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/retry delivery|resend/i);
    expect(enqueueCalls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Restore prompt' }));
    expect((screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal') as HTMLTextAreaElement).value).toBe('Redesign the Builder studio');
    expect(screen.queryByText('Not delivered')).toBeNull();
    expect(enqueueCalls).toBe(1);
    expect(enqueuedRequestIds).toHaveLength(1);
  });

  it('surfaces a recoverable timeout when Bob does not return', async () => {
    mockInvoke.mockImplementation((_name: string, options?: { body?: Record<string, unknown> }) => {
      if (options?.body?.operation === 'status') {
        return Promise.resolve({
          data: {
            turn_run: {
              request_id: options.body.request_id,
              status: 'running',
              started_at: '2026-10-11T04:00:00.000Z',
              heartbeat_at: '2026-10-11T04:02:00.000Z',
              completed_at: null,
              error_code: null,
            },
          },
          error: null,
        });
      }
      if (options?.body?.operation === 'cancel') {
        return Promise.resolve({
          data: {
            turn_run: {
              request_id: options.body.request_id,
              status: 'cancel_requested',
              started_at: '2026-10-11T04:00:00.000Z',
              heartbeat_at: '2026-10-11T04:02:00.000Z',
              completed_at: null,
              error_code: null,
            },
          },
          error: null,
        });
      }
      return new Promise(() => undefined);
    });
    const realSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 120_000) {
        if (typeof handler === 'function') handler(...args);
        return 0;
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.change(await screen.findByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Inspect the selected CCTV item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Bob is still working after 120 seconds. Check this request before retrying; the durable run prevents duplicate work.',
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));

    await waitFor(() => {
      expect(screen.getByText('Working')).toBeTruthy();
      expect(screen.queryByText('Failed/paused')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
        body: expect.objectContaining({
          operation: 'cancel',
          request_id: expect.any(String),
          conversation_id: 'conversation-1',
        }),
      }));
      expect(screen.getByText('Cancellation requested')).toBeTruthy();
      expect(screen.getByText(/next safe conductor boundary/)).toBeTruthy();
    });
  });

  it('renders durable evidence processing states from bob_attachments', async () => {
    attachmentHistory = [
      { id: 'att-1', file_name: 'agreement.pdf', file_type: 'application/pdf', file_size_bytes: 1200, processing_state: 'processing', extraction_summary: null, confidence: null, created_at: '2026-09-02T06:00:00.000Z' },
      { id: 'att-2', file_name: 'site-photo.jpg', file_type: 'image/jpeg', file_size_bytes: 900, processing_state: 'extracted', extraction_summary: 'Detected site frontage and signage.', confidence: 0.84, created_at: '2026-09-02T06:01:00.000Z' },
      { id: 'att-3', file_name: 'unclear-audio.webm', file_type: 'audio/webm', file_size_bytes: 700, processing_state: 'manual_review_required', extraction_summary: 'Audio quality needs review.', confidence: 0.42, created_at: '2026-09-02T06:02:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('3 source files in this session')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show context panel'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Files' }));

    expect(screen.getByText('agreement.pdf')).toBeTruthy();
    expect(screen.getByText('Reading/OCR')).toBeTruthy();
    expect(screen.getByText('site-photo.jpg')).toBeTruthy();
    expect(screen.getByText('Extracted · Extraction confidence 84%')).toBeTruthy();
    expect(screen.getByText('Detected site frontage and signage.')).toBeTruthy();
    expect(screen.getByText('unclear-audio.webm')).toBeTruthy();
    expect(screen.getByText('Needs review · Extraction confidence 42%')).toBeTruthy();
    expect(screen.getByText('Using app data')).toBeTruthy();
  });

  it('explains why an officer cannot attach a document for Bob extraction', async () => {
    profileRole = 'officer';
    render(<BobPanel open onClose={() => undefined} />);

    const input = await screen.findByLabelText('Attach evidence files');
    fireEvent.change(input, { target: { files: [new File(['evidence'], 'site-note.pdf', { type: 'application/pdf' })] } });

    expect((await screen.findByRole('alert')).textContent).toContain('Document and image evidence must be registered by an administrator');
    expect(screen.queryByText('site-note.pdf')).toBeNull();
  });

  it('separates assistant prose from evidence, proposal, and next-action state', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', content: 'I prepared the governed draft.', confidence: 0.91,
      flagged: false, created_at: '2026-09-02T06:00:00.000Z',
      metadata: {
        planned_tool: 'propose_client_onboarding',
        outcome: 'ok',
        action_id: 'action-1',
        suggested_action: 'Review the approval item before applying it.',
        reasoning_steps: [{ step: 1, tool: 'query_records', outcome: 'ok' }],
      },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Draft prepared')).toBeTruthy();
    expect(screen.getByText('Review the approval item before applying it.')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show context panel'));
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }));

    expect(screen.getByText('Governed actions')).toBeTruthy();
    expect(screen.getByText('Nothing is applied until a human approves it in the approval surface.')).toBeTruthy();
  });

  it('shows explicit activity state and truthful evidence intake availability', async () => {
    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Idle')).toBeTruthy();
    expect(screen.getByText('Ready for input. No Bob work is running.')).toBeTruthy();
    // Idle is announced to assistive tech but does not take a visible band above the thread.
    expect(screen.getByRole('status').className).toContain('sr-only');
    expect(screen.getByText(/Any file type up to 128 GB each/)).toBeTruthy();
    expect(screen.getByLabelText('Attach files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start voice capture' })).toBeTruthy();
  });

  it('keeps the thread uncluttered: quick actions live in the empty state and workspace boilerplate is not chipped', async () => {
    const { rerender } = render(<BobPanel open onClose={() => undefined} context={{ page: 'bob', workspace: 'agent command center', operating_model: 'research, plan, verify, propose, approve' }} />);

    expect(await screen.findByRole('button', { name: 'Plan work' })).toBeTruthy();
    expect(screen.queryByLabelText('Active context')).toBeNull();
    expect(screen.queryByText(/Start recording/)).toBeNull();

    messageHistory = [{ id: 'message-1', role: 'assistant', content: 'Here is the plan.', confidence: 0.9, flagged: false, created_at: '2026-09-02T06:00:00.000Z', metadata: {} }];
    rerender(<BobPanel open onClose={() => undefined} context={{ site: { id: 'site-1', name: 'North Plant' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Plan work' })).toBeTruthy());
  });

  it('surfaces the independent verifier verdict and delegated subagents on a reply', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', content: 'Casual Security Officer — draft agreement.', confidence: 0.88,
      flagged: false, created_at: '2026-09-02T06:00:00.000Z',
      metadata: {
        verification: { checked: true, verdict: 'repair', replanned: true, issues: [{ code: 're_ask_after_blanket_answer', severity: 'block' }] },
        subagent_runs: [{ role: 'research', goal: 'NZ COA requirements', status: 'completed' }],
      },
    }];

    render(<BobPanel open onClose={() => undefined} />);

    const badge = await screen.findByText('Checked · revised');
    expect(badge.closest('span')?.getAttribute('title')).toContain('re_ask_after_blanket_answer');
    expect(screen.getByText('Subagents: research')).toBeTruthy();
  });

  it('records voice as an audio evidence attachment', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: MediaStream) {}

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['voice bytes'], { type: 'audio/webm' }) } as BlobEvent);
        this.onstop?.();
      }
    }

    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const storageApi = { upload: vi.fn().mockResolvedValue({ error: null }), remove: vi.fn().mockResolvedValue({ error: null }) };
    mockStorageFrom.mockReturnValue(storageApi);

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start voice capture' }));
    const stopButton = await screen.findByRole('button', { name: 'Stop voice capture' });
    expect(stopButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Bob is listening')).toBeTruthy();
    expect(screen.getByText('Recording voice note')).toBeTruthy();
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(screen.getByText(/voice-note-.*\.webm/)).toBeTruthy();
      expect(screen.getByText('queued')).toBeTruthy();
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('bob-voice-transcribe', expect.objectContaining({
        body: expect.objectContaining({ language: 'en' }),
      }));
    });
    expect(stopTrack).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockStorageFrom).toHaveBeenCalledWith('bob-uploads');
      expect(storageApi.upload).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledWith('bob_attachments');
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
        body: expect.objectContaining({
          message: 'Please review the attached file(s).',
          attachments: [expect.objectContaining({ type: 'audio/webm', storage_bucket: 'bob-uploads' })],
        }),
      }));
    });
  });

  it('plays an assistant reply through the authenticated voice service', async () => {
    messageHistory = [{ id: 'assistant-voice', role: 'assistant', content: 'Voice reply', confidence: null, flagged: false, created_at: '2026-09-02T06:00:00.000Z', metadata: {} }];
    vi.stubGlobal('Audio', class { play = vi.fn().mockResolvedValue(undefined); });
    mockInvoke.mockImplementation(async (name: string) => name === 'bob-voice-speak'
      ? { data: { audio_base64: 'dGVzdA==', mime: 'audio/wav' }, error: null }
      : { data: { reply: 'ok' }, error: null });

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to this reply' }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('bob-voice-speak', {
      body: { text: 'Voice reply' },
    }));
  });

  it('names waiting-on-human and failed states plainly', async () => {
    messageHistory = [
      {
        id: 'message-1', role: 'assistant', content: 'I need one decision.', confidence: null,
        flagged: false, created_at: '2026-09-02T06:00:00.000Z', metadata: { outcome: 'need_clarification' },
      },
      {
        id: 'message-2', role: 'assistant', content: 'The task paused.', confidence: null,
        flagged: true, created_at: '2026-09-02T06:01:00.000Z', metadata: { outcome: 'failed' },
      },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Failed/paused')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show context panel'));
    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));

    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(screen.getByText('Bob recorded a failed or flagged operation for review.')).toBeTruthy();
  });

  it('shows durable conductor events in the audit inspector', async () => {
    auditHistory = [{
      id: 'event-1', turn_index: 3, step_index: 2, event_type: 'tool_completed', tool: 'repo_search', outcome: 'found', created_at: '2026-09-02T06:01:00.000Z',
    }];
    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByLabelText('Show context panel'));
    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));

    expect(await screen.findByText('repo search')).toBeTruthy();
    expect(screen.getByText(/Turn 3, step 2/)).toBeTruthy();
  });

  it('shows durable governed action status in the actions inspector', async () => {
    governedActionHistory = [{
      id: 'action-1', action_type: 'propose_roster_fill', status: 'pending', context_summary: 'Fill an unassigned overnight roster slot.', bob_reasoning: null, error_message: null, created_at: '2026-09-02T06:01:00.000Z',
    }];
    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByLabelText('Show context panel'));
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }));

    expect(await screen.findByText('propose roster fill')).toBeTruthy();
    expect(screen.getByText(/Fill an unassigned overnight roster slot/)).toBeTruthy();
  });

  it('opens as a full Bob workspace with a compact fallback', async () => {
    const { container } = render(<BobPanel open onClose={() => undefined} />);

    expect(container.querySelector('.bob-panel')?.className).toContain('is-expanded');
    expect(screen.getByLabelText('Use compact panel')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Use compact panel'));
    expect(container.querySelector('.bob-panel')?.className).not.toContain('is-expanded');
    expect(screen.getByLabelText('Open full workspace')).toBeTruthy();
  });

  it('shows session history and a context panel in the expanded workspace', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'Zone compliance review', created_at: '2026-09-02T05:00:00.000Z', updated_at: '2026-09-02T06:00:00.000Z' },
      { id: 'conversation-2', title: 'Roster gap analysis', created_at: '2026-08-20T05:00:00.000Z', updated_at: '2026-08-20T06:00:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(screen.getByLabelText('Show context panel'));

    expect(await screen.findByLabelText('Bob sessions')).toBeTruthy();
    expect(screen.getByLabelText('Search chats')).toBeTruthy();
    expect(screen.getByText('Zone compliance review')).toBeTruthy();
    expect(screen.getByText('Roster gap analysis')).toBeTruthy();

    expect(screen.getByLabelText('Bob context panel')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Actions' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Audit' })).toBeTruthy();
  });

  it('filters the session list by search term', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'Zone compliance review', created_at: '2026-09-02T05:00:00.000Z', updated_at: '2026-09-02T06:00:00.000Z' },
      { id: 'conversation-2', title: 'Roster gap analysis', created_at: '2026-08-20T05:00:00.000Z', updated_at: '2026-08-20T06:00:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.change(await screen.findByLabelText('Search chats'), { target: { value: 'roster' } });

    expect(screen.queryByText('Zone compliance review')).toBeNull();
    expect(await screen.findByText('Roster gap analysis')).toBeTruthy();
  });

  it('shows the active conversation reference and lets the owner page past 100 chats', async () => {
    setViewport(1400);
    conversationList = Array.from({ length: 125 }, (_, index) => ({
      id: index === 0 ? 'conversation-1' : `conversation-${String(index + 1).padStart(3, '0')}`,
      title: `Request ${index + 1}`,
      human_reference: `BOB-${index + 1}`,
      created_at: '2026-09-02T05:00:00.000Z',
      updated_at: new Date(Date.UTC(2026, 10, 9) - index * 60_000).toISOString(),
    }));

    render(<BobPanel open onClose={() => undefined} />);

    expect((await screen.findByLabelText('Conversation reference')).textContent).toContain('BOB-1');
    expect(await screen.findByText('Request 1')).toBeTruthy();
    expect(screen.queryByText('Request 101')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more chats' }));
    await screen.findByText('Request 100');
    fireEvent.click(screen.getByRole('button', { name: 'Load more chats' }));
    expect(await screen.findByText('Request 125')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more chats' })).toBeNull();
  });

  it('finds older conversations by their reference and by literal title without loading preceding pages', async () => {
    setViewport(1400);
    conversationList = Array.from({ length: 125 }, (_, index) => ({
      id: index === 0 ? 'conversation-1' : `conversation-${String(index + 1).padStart(3, '0')}`,
      title: index === 124 ? 'Old 100% literal_rate' : `Request ${index + 1}`,
      human_reference: `BOB-${index + 1}`,
      updated_at: new Date(Date.UTC(2026, 10, 9) - index * 60_000).toISOString(),
    }));
    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByText('Request 1');
    expect(screen.queryByText('Old 100% literal_rate')).toBeNull();

    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'BOB-125' } });
    expect(await screen.findByText('Old 100% literal_rate')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: '100% literal_rate' } });
    expect(await screen.findByText('Old 100% literal_rate')).toBeTruthy();
  });

  it('does not strand the chat list when the active filter is clicked while loading', async () => {
    setViewport(1400);
    const row = fixtureSession({ id: 'conversation-1', title: 'Loading conversation' }, 0);
    let resolveList!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    const pending = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { resolveList = resolve; });
    conversationList = [row];
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === 'bob_list_conversations' ? pending : fixtureRpc(name, args));
    render(<BobPanel open onClose={() => undefined} />);

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('bob_list_conversations', expect.anything()));
    fireEvent.click(within(screen.getByLabelText('Session filters')).getByRole('button', { name: 'all' }));
    await act(async () => { resolveList({ data: [row], error: null }); await pending; });
    expect(await screen.findByText('Loading conversation')).toBeTruthy();
  });

  it.each([
    { change: 'workspace', organizationId: 'org-1', mode: 'builder' as const },
    { change: 'organization', organizationId: 'org-2', mode: 'operations' as const },
  ])('does not restore the previous $change when its conversation lookup finishes late', async ({ organizationId, mode }) => {
    setViewport(1400);
    const oldSession = fixtureSession({ id: 'old', title: 'Old scope', human_reference: 'BOB-1' }, 0);
    const newSession = fixtureSession({
      id: 'new', title: 'New scope', human_reference: 'BOB-2', organization_id: organizationId, module_key: mode,
    }, 1);
    conversationList = [oldSession, newSession];
    let resolveOld!: (value: { data: Record<string, unknown>; error: null }) => void;
    const oldLookup = new Promise<{ data: Record<string, unknown>; error: null }>(resolve => { resolveOld = resolve; });
    let oldLookupStarted = false;
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_conversations') return originalFrom(table);
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (field: string, value: unknown) => { filters[field] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          if (filters.organization_id === 'org-1' && filters.module_key === 'operations') {
            oldLookupStarted = true;
            return oldLookup;
          }
          return Promise.resolve({ data: newSession, error: null });
        },
      };
      return { select: () => query };
    });

    const { rerender } = render(<BobPanel open onClose={() => undefined} mode="operations" />);
    await waitFor(() => expect(oldLookupStarted).toBe(true));
    profileOrganizationId = organizationId;
    rerender(<BobPanel open onClose={() => undefined} mode={mode} />);
    await waitFor(() => expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2'));
    await act(async () => { resolveOld({ data: oldSession, error: null }); await oldLookup; });
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2');
    expect(screen.queryByText('Old scope')).toBeNull();
  });

  it('does not create an old-workspace conversation after switching workspaces', async () => {
    setViewport(1400);
    const newSession = fixtureSession({
      id: 'new', title: 'Builder scope', human_reference: 'BOB-2', module_key: 'builder',
    }, 1);
    conversationList = [newSession];
    let resolveOld!: (value: { data: null; error: null }) => void;
    const oldLookup = new Promise<{ data: null; error: null }>(resolve => { resolveOld = resolve; });
    let oldLookupStarted = false;
    const insert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: fixtureSession({ id: 'unexpected' }, 2), error: null }) }),
    }));
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_conversations') return originalFrom(table);
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (field: string, value: unknown) => { filters[field] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          if (filters.module_key === 'operations') {
            oldLookupStarted = true;
            return oldLookup;
          }
          return Promise.resolve({ data: newSession, error: null });
        },
      };
      return { select: () => query, insert };
    });

    const { rerender } = render(<BobPanel open onClose={() => undefined} mode="operations" />);
    await waitFor(() => expect(oldLookupStarted).toBe(true));
    rerender(<BobPanel open onClose={() => undefined} mode="builder" />);
    await waitFor(() => expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2'));
    await act(async () => { resolveOld({ data: null, error: null }); await oldLookup; });
    expect(insert).not.toHaveBeenCalled();
  });

  it('confirms an edited conversation name against its reference before showing it saved', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Old name', human_reference: 'BOB-1' }];
    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Old name' }));
    const input = screen.getByLabelText('Session title');
    fireEvent.change(input, { target: { value: 'Site investigation' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Name saved for BOB-1.')).toBeTruthy();
    expect(await screen.findByText('Site investigation')).toBeTruthy();
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-1');
  });

  it('lets an owner explicitly keep the current generic conversation name', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Bob Operations', human_reference: 'BOB-1' }];
    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Bob Operations' }));
    fireEvent.keyDown(screen.getByLabelText('Session title'), { key: 'Enter' });

    expect(await screen.findByText('Name saved for BOB-1.')).toBeTruthy();
    expect(mockRpc).toHaveBeenCalledWith('bob_rename_conversation', expect.objectContaining({
      p_expected_title: 'Bob Operations', p_title: 'Bob Operations',
    }));
  });

  it('keeps the previous name and shows an error when the rename is not saved', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Old name', human_reference: 'BOB-1' }];
    const onClose = vi.fn();
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === 'bob_rename_conversation'
        ? Promise.resolve({ data: null, error: { message: 'Rename was denied.' } })
        : fixtureRpc(name, args));
    render(<BobPanel open onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Old name' }));
    const input = screen.getByLabelText('Session title');
    fireEvent.change(input, { target: { value: 'Not saved' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((await screen.findByRole('alert')).textContent).toContain('Rename was denied.');
    expect((screen.getByLabelText('Session title') as HTMLInputElement).value).toBe('Not saved');
    fireEvent.keyDown(screen.getByLabelText('Session title'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Old name')).toBeTruthy();
    expect(screen.queryByText('Name saved for BOB-1.')).toBeNull();
  });

  it('keeps a renamed conversation when an older history page finishes afterward', async () => {
    setViewport(1400);
    conversationList = Array.from({ length: 51 }, (_, index) => ({
      id: index === 0 ? 'conversation-1' : `conversation-${index + 1}`,
      title: index === 0 ? 'Old name' : `Request ${index + 1}`,
      human_reference: `BOB-${index + 1}`,
      updated_at: new Date(Date.UTC(2026, 10, 9) - index * 60_000).toISOString(),
    }));
    const old = fixtureSession(conversationList[0], 0);
    let resolveOlder!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    const older = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { resolveOlder = resolve; });
    let olderStarted = false;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_list_conversations' && args.p_cursor_updated_at) {
        olderStarted = true;
        return older;
      }
      return fixtureRpc(name, args);
    });

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more chats' }));
    await waitFor(() => expect(olderStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Old name' }));
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'New name' } });
    fireEvent.keyDown(screen.getByLabelText('Session title'), { key: 'Enter' });
    await screen.findByText('Name saved for BOB-1.');
    await act(async () => { resolveOlder({ data: [old], error: null }); await older; });
    expect(await screen.findByText('New name')).toBeTruthy();
    expect(screen.queryByText('Old name')).toBeNull();
  });

  it('does not replace a newer chat search with a delayed older search', async () => {
    setViewport(1400);
    const first = fixtureSession({ id: 'conversation-1', title: 'First result', human_reference: 'BOB-1' }, 0);
    const second = fixtureSession({ id: 'conversation-2', title: 'Second result', human_reference: 'BOB-2' }, 1);
    conversationList = [first, second];
    let resolveFirst!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    const firstSearch = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { resolveFirst = resolve; });
    let firstStarted = false;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_list_conversations' && args.p_search === 'first') {
        firstStarted = true;
        return firstSearch;
      }
      return fixtureRpc(name, args);
    });

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Search chats'), { target: { value: 'first' } });
    await waitFor(() => expect(firstStarted).toBe(true));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'second' } });
    expect(await screen.findByText('Second result')).toBeTruthy();
    await act(async () => { resolveFirst({ data: [first], error: null }); await firstSearch; });
    expect(screen.getByText('Second result')).toBeTruthy();
    expect(screen.queryByText('First result')).toBeNull();
  });

  it('keeps the current search when an earlier conversation rename finishes', async () => {
    setViewport(1400);
    const first = fixtureSession({ id: 'conversation-1', title: 'First result', human_reference: 'BOB-1' }, 0);
    const second = fixtureSession({ id: 'conversation-2', title: 'Second result', human_reference: 'BOB-2' }, 1);
    conversationList = [first, second];
    let finishRename!: (value: { data: Record<string, unknown>; error: null }) => void;
    const pendingRename = new Promise<{ data: Record<string, unknown>; error: null }>(resolve => { finishRename = resolve; });
    let renameStarted = false;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_rename_conversation') {
        renameStarted = true;
        return pendingRename;
      }
      return fixtureRpc(name, args);
    });

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename First result' }));
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed first' } });
    fireEvent.keyDown(screen.getByLabelText('Session title'), { key: 'Enter' });
    await waitFor(() => expect(renameStarted).toBe(true));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'second' } });
    expect(await screen.findByText('Second result')).toBeTruthy();

    const renamed = { ...first, title: 'Renamed first', updated_at: '2030-01-01T00:00:00.000Z' };
    conversationList[0] = renamed;
    await act(async () => { finishRename({ data: renamed, error: null }); await pendingRename; });
    await waitFor(() => expect(screen.getByText('Second result')).toBeTruthy());
    expect((screen.getByLabelText('Search chats') as HTMLInputElement).value).toBe('second');
    expect(screen.queryByText('Renamed first')).toBeNull();
  });

  it('retries a failed older chat page without losing already loaded history', async () => {
    setViewport(1400);
    conversationList = Array.from({ length: 51 }, (_, index) => ({
      id: index === 0 ? 'conversation-1' : `conversation-${index + 1}`,
      title: `Request ${index + 1}`,
      human_reference: `BOB-${index + 1}`,
      updated_at: new Date(Date.UTC(2026, 10, 9) - index * 60_000).toISOString(),
    }));
    let fail = true;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_list_conversations' && args.p_cursor_updated_at && fail) {
        fail = false;
        return Promise.resolve({ data: null, error: { message: 'Older chats unavailable' } });
      }
      return fixtureRpc(name, args);
    });

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more chats' }));
    expect(await screen.findByText(/Older chats unavailable/)).toBeTruthy();
    expect(screen.getByText('Request 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading chats' }));
    expect(await screen.findByText('Request 51')).toBeTruthy();
    expect(screen.getByText('Request 1')).toBeTruthy();
  });

  it('reports an unconfirmed reference instead of claiming a new conversation started', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Existing work', human_reference: 'BOB-1' }];
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      const source = originalFrom(table);
      if (table !== 'bob_conversations') return source;
      return {
        ...source,
        insert: () => ({ select: () => ({ single: async () => ({
          data: fixtureSession({ id: 'new', human_reference: null }, 1), error: null,
        }) }) }),
      };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByText('Existing work');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not confirm the conversation and its reference/i);
    expect(screen.queryByText(/Started BOB-/)).toBeNull();
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-1');
  });

  it('refreshes the automatic conversation name after the first turn is persisted', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Bob Operations', human_reference: 'BOB-1' }];
    const old = fixtureSession(conversationList[0], 0);
    let resolveOldList!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    const oldList = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { resolveOldList = resolve; });
    let listStarted = false;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_list_conversations' && !listStarted) {
        listStarted = true;
        return oldList;
      }
      return fixtureRpc(name, args);
    });
    mockInvoke.mockImplementation(async (name: string) => {
      if (name === 'onspace-ai-chat') {
        conversationList[0] = { ...conversationList[0], title: 'Investigate late reports' };
        messageHistory = [{
          id: 'message-1', role: 'user', content: 'Investigate late reports', confidence: null,
          flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {},
        }];
      }
      return { data: { reply: 'I will investigate.' }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    await waitFor(() => expect(listStarted).toBe(true));
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Investigate late reports' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockFrom.mock.calls.filter(([table]) => table === 'bob_conversations').length).toBeGreaterThan(1));
    await act(async () => { resolveOldList({ data: [old], error: null }); await oldList; });
    expect(await screen.findByText('Investigate late reports', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-1');
  });

  it('refreshes an automatic name after a queued turn completes while history is loading', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Bob Operations', human_reference: 'BOB-1' }];
    const old = fixtureSession(conversationList[0], 0);
    let resolveOldList!: (value: { data: Array<Record<string, unknown>>; error: null }) => void;
    const oldList = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { resolveOldList = resolve; });
    let listStarted = false;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bob_list_conversations' && !listStarted) {
        listStarted = true;
        return oldList;
      }
      return fixtureRpc(name, args);
    });
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      const requestId = String(options?.body?.request_id);
      if (options?.body?.operation === 'status') {
        conversationList[0] = { ...conversationList[0], title: 'Investigate queued work' };
        messageHistory = [{
          id: 'message-1', role: 'user', content: 'Investigate queued work', confidence: null,
          flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {},
        }];
        return { data: { turn_run: { request_id: requestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
      }
      return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    await waitFor(() => expect(listStarted).toBe(true));
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Investigate queued work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockFrom.mock.calls.filter(([table]) => table === 'bob_conversations').length).toBeGreaterThan(1));
    await act(async () => { resolveOldList({ data: [old], error: null }); await oldList; });
    expect(await screen.findByText('Investigate queued work', { selector: 'strong' })).toBeTruthy();
  });

  it('keeps a completed request recoverable when its conversation cannot be refreshed', async () => {
    setViewport(1400);
    const session = fixtureSession({ id: 'conversation-1', title: 'Review reports', human_reference: 'BOB-1' }, 0);
    conversationList = [session];
    let refreshAvailable = false;
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_conversations') return originalFrom(table);
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (field: string, value: unknown) => { filters[field] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => filters.id && !refreshAvailable
          ? { data: null, error: { message: 'Conversation refresh unavailable' } }
          : { data: session, error: null },
      };
      return { select: () => query };
    });
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      const requestId = String(options?.body?.request_id);
      const status = options?.body?.operation === 'status' ? 'completed' : 'queued';
      return { data: { turn_run: { request_id: requestId, status, started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Review the reports' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Conversation refresh unavailable');
    expect(screen.getByRole('region', { name: 'Bob request recovery' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    refreshAvailable = true;
    messageHistory = [{
      id: 'answer-1', role: 'assistant', content: 'The report review is complete.', confidence: null,
      flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {},
    }];
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('The report review is complete.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Bob request recovery' })).toBeNull();
  });

  it('keeps the completed request receipt when loading its attachments fails', async () => {
    setViewport(1400);
    conversationList = [{ id: 'conversation-1', title: 'Review reports', human_reference: 'BOB-1' }];
    let turnCompleted = false;
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_attachments' || !turnCompleted) return originalFrom(table);
      return { select: () => ({ eq: () => ({ order: async () => ({
        data: null, error: { message: 'Conversation attachments unavailable' },
      }) }) }) };
    });
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      const requestId = String(options?.body?.request_id);
      const status = options?.body?.operation === 'status' ? 'completed' : 'queued';
      if (status === 'completed') turnCompleted = true;
      return { data: { turn_run: { request_id: requestId, status, started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Review the reports' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Conversation attachments unavailable');
    expect(screen.getByRole('region', { name: 'Bob request recovery' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
  });

  it('does not reopen the previous conversation when its queued turn finishes during a new selection', async () => {
    setViewport(1400);
    const first = fixtureSession({ id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' }, 0);
    const second = fixtureSession({ id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' }, 1);
    conversationList = [first, second];
    let finishFirst!: (value: { data: Record<string, unknown>; error: null }) => void;
    let finishSecond!: (value: { data: Record<string, unknown>; error: null }) => void;
    let finishStatus!: (value: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
    const firstLookup = new Promise<{ data: Record<string, unknown>; error: null }>(resolve => { finishFirst = resolve; });
    const secondLookup = new Promise<{ data: Record<string, unknown>; error: null }>(resolve => { finishSecond = resolve; });
    const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
    let secondLookupStarted = false;
    let statusRequestId = '';
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_conversations') return originalFrom(table);
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (field: string, value: unknown) => { filters[field] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          if (filters.id === second.id) { secondLookupStarted = true; return secondLookup; }
          if (filters.id === first.id) return firstLookup;
          return Promise.resolve({ data: first, error: null });
        },
      };
      return { select: () => query };
    });
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      const requestId = String(options?.body?.request_id);
      if (options?.body?.operation === 'status') {
        statusRequestId = requestId;
        return statusResult;
      }
      return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Review the first conversation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(statusRequestId).not.toBe(''));
    const openSecond = await screen.findByRole('button', { name: /Second conversation.*BOB-2/ });
    await waitFor(() => expect(openSecond.hasAttribute('disabled')).toBe(false));
    fireEvent.click(openSecond);
    await waitFor(() => expect(secondLookupStarted).toBe(true));
    await act(async () => {
      finishStatus({ data: { turn_run: { request_id: statusRequestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
      await statusResult;
    });
    await act(async () => { finishSecond({ data: second, error: null }); await secondLookup; });
    await waitFor(() => expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2'));
    await act(async () => { finishFirst({ data: first, error: null }); await firstLookup; });
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2');
  });

  it('resumes recovery for the displayed conversation when a new selection fails', async () => {
    setViewport(1400);
    const first = fixtureSession({ id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' }, 0);
    const second = fixtureSession({ id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' }, 1);
    conversationList = [first, second];
    let finishStatus!: (value: { data: { turn_run: Record<string, unknown> }; error: null }) => void;
    const statusResult = new Promise<{ data: { turn_run: Record<string, unknown> }; error: null }>(resolve => { finishStatus = resolve; });
    let statusRequestId = '';
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_conversations') return originalFrom(table);
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (field: string, value: unknown) => { filters[field] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => filters.id === second.id
          ? { data: null, error: { message: 'Other conversation unavailable' } }
          : { data: first, error: null },
      };
      return { select: () => query };
    });
    mockInvoke.mockImplementation(async (name: string, options?: { body?: Record<string, unknown> }) => {
      if (name !== 'onspace-ai-chat') return { data: null, error: null };
      const requestId = String(options?.body?.request_id);
      if (options?.body?.operation === 'status') { statusRequestId = requestId; return statusResult; }
      return { data: { turn_run: { request_id: requestId, status: 'queued', started_at: '2026-11-10T00:00:00.000Z' } }, error: null };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Review the first conversation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(statusRequestId).not.toBe(''));
    const openSecond = await screen.findByRole('button', { name: /Second conversation.*BOB-2/ });
    await waitFor(() => expect(openSecond.hasAttribute('disabled')).toBe(false));
    fireEvent.click(openSecond);
    expect((await screen.findByRole('alert')).textContent).toContain('Other conversation unavailable');

    messageHistory = [{ id: 'answer-1', role: 'assistant', content: 'First conversation completed.', confidence: null,
      flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {} }];
    await act(async () => {
      finishStatus({ data: { turn_run: { request_id: statusRequestId, status: 'completed', started_at: '2026-11-10T00:00:00.000Z' } }, error: null });
      await statusResult;
    });
    expect(await screen.findByText('First conversation completed.')).toBeTruthy();
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-1');
  });

  it('does not show attachments from an older selection after switching through search results', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' },
      { id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' },
    ];
    const firstAttachment = { id: 'file-1', file_name: 'first-private.pdf', file_type: 'application/pdf', file_size_bytes: 100,
      processing_state: 'extracted', extraction_summary: null, confidence: null, created_at: '2026-11-10T00:00:00.000Z' };
    const secondAttachment = { ...firstAttachment, id: 'file-2', file_name: 'second-visible.pdf' };
    let delayFirst = false;
    let firstStarted = false;
    let finishFirst!: (result: { data: Array<Record<string, unknown>>; error: null }) => void;
    const firstResponse = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { finishFirst = resolve; });
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_attachments') return originalFrom(table);
      return { select: () => ({ eq: (field: string, value: string) => {
        if (field === 'organization_id') return { ilike: () => ({ order: () => ({ limit: async () => ({
          data: [
            { id: 'result-1', file_name: 'first evidence', processing_state: 'extracted', conversation_id: 'conversation-1' },
            { id: 'result-2', file_name: 'second evidence', processing_state: 'extracted', conversation_id: 'conversation-2' },
          ], error: null,
        }) }) }) };
        return { order: () => {
          if (value === 'conversation-1' && delayFirst) { firstStarted = true; return firstResponse; }
          return Promise.resolve({ data: value === 'conversation-1' ? [firstAttachment] : [secondAttachment], error: null });
        } };
      } }) };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.click(screen.getByLabelText('Show context panel'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Files' }));
    await screen.findByText('first-private.pdf');
    delayFirst = true;
    fireEvent.click(screen.getByRole('button', { name: 'files' }));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'evidence' } });
    fireEvent.click(await screen.findByRole('button', { name: /first evidence/ }));
    await waitFor(() => expect(firstStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /second evidence/ }));
    await screen.findByText('second-visible.pdf');
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2');

    await act(async () => { finishFirst({ data: [firstAttachment], error: null }); await firstResponse; });
    expect(screen.getByText('second-visible.pdf')).toBeTruthy();
    expect(screen.queryByText('first-private.pdf')).toBeNull();
  });

  it('prevents a file search result from switching conversations while a turn is sending', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' },
      { id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' },
    ];
    let finishSend!: (result: { data: { reply: string }; error: null }) => void;
    const sendResult = new Promise<{ data: { reply: string }; error: null }>(resolve => { finishSend = resolve; });
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_attachments') return originalFrom(table);
      return { ...originalFrom(table), select: () => ({ eq: (field: string) => field === 'organization_id'
        ? { ilike: () => ({ order: () => ({ limit: async () => ({ data: [
          { id: 'result-2', file_name: 'second evidence', processing_state: 'extracted', conversation_id: 'conversation-2' },
        ], error: null }) }) }) }
        : { order: async () => ({ data: [], error: null }) } }) };
    });
    mockInvoke.mockImplementation((name: string) => name === 'onspace-ai-chat'
      ? sendResult : Promise.resolve({ data: null, error: null }));

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.click(screen.getByRole('button', { name: 'files' }));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'evidence' } });
    const result = await screen.findByRole('button', { name: /second evidence/ });
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), {
      target: { value: 'Review the first conversation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(result).toHaveProperty('disabled', true);
    fireEvent.click(result);
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-1');
    await act(async () => { finishSend({ data: { reply: 'First reply' }, error: null }); await sendResult; });
    await waitFor(() => expect(result).toHaveProperty('disabled', false));
  });

  it('does not let the initial conversation load replace a newer search selection', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' },
      { id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' },
    ];
    const firstMessage = { id: 'message-1', role: 'assistant', content: 'First conversation answer', confidence: null,
      flagged: false, created_at: '2026-11-10T00:00:00.000Z', metadata: {} };
    const secondMessage = { ...firstMessage, id: 'message-2', content: 'Second conversation answer' };
    let finishFirst!: (result: { data: Array<Record<string, unknown>>; error: null }) => void;
    const firstResponse = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { finishFirst = resolve; });
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_messages') return { select: () => ({ eq: (_field: string, value: string) => ({
        order: () => value === 'conversation-1' ? firstResponse : Promise.resolve({ data: [secondMessage], error: null }),
      }) }) };
      if (table !== 'bob_attachments') return originalFrom(table);
      return { ...originalFrom(table), select: () => ({ eq: (field: string) => field === 'organization_id'
        ? { ilike: () => ({ order: () => ({ limit: async () => ({ data: [
          { id: 'result-2', file_name: 'second evidence', processing_state: 'extracted', conversation_id: 'conversation-2' },
        ], error: null }) }) }) }
        : { order: async () => ({ data: [], error: null }) } }) };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.click(screen.getByRole('button', { name: 'files' }));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'evidence' } });
    fireEvent.click(await screen.findByRole('button', { name: /second evidence/ }));
    await screen.findByText('Second conversation answer');
    expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2');

    await act(async () => { finishFirst({ data: [firstMessage], error: null }); await firstResponse; });
    expect(screen.getByText('Second conversation answer')).toBeTruthy();
    expect(screen.queryByText('First conversation answer')).toBeNull();
  });

  it('does not display the previous conversation files while the selected conversation is loading', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'First conversation', human_reference: 'BOB-1' },
      { id: 'conversation-2', title: 'Second conversation', human_reference: 'BOB-2' },
    ];
    const firstAttachment = { id: 'file-1', file_name: 'first-private.pdf', file_type: 'application/pdf', file_size_bytes: 100,
      processing_state: 'extracted', extraction_summary: null, confidence: null, created_at: '2026-11-10T00:00:00.000Z' };
    const secondAttachment = { ...firstAttachment, id: 'file-2', file_name: 'second-visible.pdf' };
    let finishSecond!: (result: { data: Array<Record<string, unknown>>; error: null }) => void;
    const secondResponse = new Promise<{ data: Array<Record<string, unknown>>; error: null }>(resolve => { finishSecond = resolve; });
    const originalFrom = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'bob_attachments') return originalFrom(table);
      return { select: () => ({ eq: (field: string, value: string) => {
        if (field === 'organization_id') return { ilike: () => ({ order: () => ({ limit: async () => ({ data: [
          { id: 'result-2', file_name: 'second evidence', processing_state: 'extracted', conversation_id: 'conversation-2' },
        ], error: null }) }) }) };
        return { order: () => value === 'conversation-2'
          ? secondResponse : Promise.resolve({ data: [firstAttachment], error: null }) };
      } }) };
    });

    render(<BobPanel open onClose={() => undefined} />);
    await screen.findByLabelText('Conversation reference');
    fireEvent.click(screen.getByLabelText('Show context panel'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Files' }));
    await screen.findByText('first-private.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'files' }));
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'evidence' } });
    fireEvent.click(await screen.findByRole('button', { name: /second evidence/ }));
    await waitFor(() => expect(screen.getByLabelText('Conversation reference').textContent).toContain('BOB-2'));
    expect(screen.queryByText('first-private.pdf')).toBeNull();

    await act(async () => { finishSecond({ data: [secondAttachment], error: null }); await secondResponse; });
    expect(await screen.findByText('second-visible.pdf')).toBeTruthy();
  });

  it('resizes expanded desktop panes within their bounded widths', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'Zone compliance review', pinned: false, archived_at: null, created_at: '2026-09-02T05:00:00.000Z', updated_at: '2026-09-02T06:00:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    const sessions = await screen.findByLabelText('Bob sessions');
    fireEvent.pointerDown(screen.getByLabelText('Resize sessions pane'), { clientX: 300 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 380, bubbles: true }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });

    expect(sessions.getAttribute('style')).toContain('flex-basis: 362px');
  });

  it('keeps sessions and context reachable as drawers on mobile', async () => {
    setViewport(430);
    conversationList = [
      { id: 'conversation-1', title: 'Zone compliance review', created_at: '2026-09-02T05:00:00.000Z', updated_at: '2026-09-02T06:00:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByLabelText('Show sessions')).toBeTruthy();
    expect(screen.queryByLabelText('Bob sessions')).toBeNull();
    expect(screen.queryByLabelText('Bob context panel')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show sessions'));
    expect(await screen.findByLabelText('Bob sessions')).toBeTruthy();
    expect(screen.getByText('Zone compliance review')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close sessions'));
    expect(screen.queryByLabelText('Bob sessions')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show context panel'));
    expect(await screen.findByLabelText('Bob context panel')).toBeTruthy();
  });

  it('uses the dedicated Builder mode for coding-oriented agent prompts', async () => {
    render(<BobPanel open mode="builder" onClose={() => undefined} context={{ job_title: 'Mobile field reporting' }} />);

    expect(await screen.findByText('Bob Builder')).toBeTruthy();
    expect(screen.getByText('What should we build?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan implementation' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Describe what you want to build, change, or fix')).toBeTruthy();
    expect(mockFrom).toHaveBeenCalledWith('bob_conversations');
  });

  it('renders Builder as an embedded coding agent without modal or expansion controls', async () => {
    const onClose = vi.fn();
    render(<BobPanel open mode="builder" presentation="docked" onClose={onClose} context={{ job_title: 'Mobile field reporting' }} />);

    const agent = await screen.findByRole('complementary', { name: 'Bob Builder coding agent' });
    expect(agent.getAttribute('aria-modal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open full workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open document studio' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Bob Builder' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an explicit close button and dismisses the workspace', async () => {
    const onClose = vi.fn();
    render(<BobPanel open onClose={onClose} />);

    const close = await screen.findByRole('button', { name: 'Close Bob' });
    expect(close.textContent).toContain('Close');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a full-page studio for documents, diagrams, and media without forcing side panes open', async () => {
    setViewport(1440);
    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByLabelText('Bob sessions')).toBeTruthy();
    fireEvent.click(await screen.findByLabelText('Open document studio'));

    expect(await screen.findByLabelText('Bob studio')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Documents/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Diagrams/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Media/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /RFQ response/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Employment contract draft/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Report design/ })).toBeTruthy();
    expect(screen.queryByLabelText('Bob sessions')).toBeNull();
    expect(screen.queryByLabelText('Bob context panel')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /RFQ response/ }));
    expect(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal')).toHaveProperty('value', expect.stringContaining('Draft an RFQ response'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', expect.objectContaining({
      body: expect.objectContaining({
        context: expect.objectContaining({
          studio_artifact_type: 'document',
          studio_document_kind: 'rfq_response',
        }),
      }),
    })));
  });

  it('records one reasoned perception-field decision and shows the persisted receipt state', async () => {
    attachmentHistory = [{
      id: 'attachment-evidence',
      file_name: 'vehicle-log.jpg',
      file_type: 'image/jpeg',
      processing_state: 'extracted',
      extraction_summary: 'Vehicle plate candidate found.',
      confidence: 0.91,
      extraction_payload: {
        structured_extraction: {
          document_kind: 'vehicle_log',
          perception_envelope_id: 'envelope-1',
          identifier_verification: {
            plate_number: {
              status: 'manual_review_required',
              value: 'ABC123',
              candidates: [{ value: 'ABC123' }],
            },
          },
        },
      },
    }];
    perceptionEnvelopeHistory = [{
      id: 'envelope-1',
      domain: 'vehicle_identity',
      schema_version: 1,
      status: 'manual_review_required',
      created_at: '2026-10-16T08:00:00.000Z',
    }];
    perceptionFieldHistory = [{
      id: 'field-1',
      envelope_id: 'envelope-1',
      field_key: 'vehicle.plate_number',
      candidate_value: 'ABC123',
      normalized_value: 'ABC123',
      raw_confidence: 0.91,
      calibrated_confidence: 0.88,
      source_locations: [{ page: 1, box: [10, 20, 80, 40] }],
      conflicts: [],
      authority_state: 'verified_candidate',
      review_required: true,
    }];
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === 'review_perception_evidence_field'
        ? Promise.resolve({
          data: { ...perceptionFieldHistory[0], authority_state: 'human_approved', review_required: false },
          error: null,
        })
        : fixtureRpc(name, args));

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Open document studio'));

    const approve = await screen.findByRole('button', { name: 'Approve field' });
    fireEvent.click(approve);
    expect(await screen.findByText('Record the source comparison or uncertainty before deciding.')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('What did you compare, and what supports this decision?'), {
      target: { value: 'Compared the source image with the vehicle log entry.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve field' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('review_perception_evidence_field', {
      p_field_id: 'field-1',
      p_decision: 'approve',
      p_reviewer_notes: 'Compared the source image with the vehicle log entry.',
      p_canonical_reference: {},
    }));
    expect(await screen.findByText('Evidence field approved with a durable human-review receipt.')).toBeTruthy();
    expect(screen.getByText('Human decision recorded. This field is no longer awaiting review.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve field' })).toBeNull();
  });

  it('expands compact mode when Studio opens and closes incidental side panes', async () => {
    setViewport(1440);
    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByLabelText('Use compact panel'));
    expect(screen.getByLabelText('Open full workspace')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show context panel'));
    expect(screen.getByLabelText('Bob context panel')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Open document studio'));

    expect(await screen.findByLabelText('Bob studio')).toBeTruthy();
    expect(screen.getByLabelText('Use compact panel')).toBeTruthy();
    expect(screen.queryByLabelText('Bob context panel')).toBeNull();
    expect(screen.queryByLabelText('Bob sessions')).toBeNull();
  });

  it('shows only explicitly typed Studio artifacts instead of treating ordinary replies as drafts', async () => {
    messageHistory = [
      {
        id: 'message-chat',
        role: 'assistant',
        flagged: false,
        confidence: null,
        created_at: '2026-09-02T05:59:00.000Z',
        content: 'This is an ordinary chat answer.',
        metadata: {},
      },
      {
        id: 'message-rfq',
        role: 'assistant',
        flagged: false,
        confidence: null,
        created_at: '2026-09-02T06:00:00.000Z',
        content: '# Grounded RFQ draft',
        metadata: { studio_artifact_type: 'document', studio_document_kind: 'rfq_response' },
      },
    ];

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Open document studio'));

    const studio = await screen.findByLabelText('Bob studio');
    expect(within(studio).getByText('Grounded RFQ draft')).toBeTruthy();
    expect(within(studio).queryByText('This is an ordinary chat answer.')).toBeNull();
    expect(within(studio).getByRole('tab', { name: 'Documents 1' })).toBeTruthy();
  });

  it('extracts explicitly typed Mermaid diagrams from Bob responses for studio rendering', () => {
    const diagrams = extractMermaidDiagrams([{
      id: 'message-1',
      role: 'assistant',
      created_at: '2026-09-02T06:00:00.000Z',
      content: '### Flow\n\n```mermaid\nflowchart LR\n  Intake --> Review\n  Review --> Publish\n```',
      metadata: { studio_artifact_type: 'diagram' },
    }]);

    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].chart).toContain('Intake --> Review');
  });

  it('renders image and direct video markdown as safe media elements', async () => {
    messageHistory = [{
      id: 'message-1', role: 'assistant', flagged: false, confidence: null,
      created_at: '2026-09-02T06:00:00.000Z',
      content: '![Site photo](https://example.com/site.jpg)\n\n[Patrol video](https://example.com/patrol.mp4)',
      metadata: {},
    }];

    render(<BobPanel open onClose={() => undefined} />);

    expect((await screen.findByAltText('Site photo')).getAttribute('src')).toBe('https://example.com/site.jpg');
    expect(screen.getByLabelText('Patrol video').getAttribute('src')).toBe('https://example.com/patrol.mp4');
  });

  it('opens private attached media through a signed preview in the studio', async () => {
    attachmentHistory = [{
      id: 'att-image', file_name: 'site-photo.jpg', file_type: 'image/jpeg', file_size_bytes: 900,
      storage_bucket: 'bob-uploads', storage_path: 'org/org-1/bob/conversation-1/site-photo.jpg',
      processing_state: 'extracted', extraction_summary: 'Detected site frontage.', confidence: 0.84,
      created_at: '2026-09-02T06:01:00.000Z',
    }];
    const storageApi = { upload: vi.fn(), remove: vi.fn(), createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/site-photo.jpg' }, error: null }) };
    mockStorageFrom.mockReturnValue(storageApi);

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Open document studio'));
    fireEvent.click(screen.getByRole('tab', { name: /Media/ }));

    const image = await screen.findByAltText('site-photo.jpg');
    expect(image.getAttribute('src')).toBe('https://signed.example/site-photo.jpg');
    expect(storageApi.createSignedUrl).toHaveBeenCalledWith('org/org-1/bob/conversation-1/site-photo.jpg', 3600);
  });

  it('shows private source images directly in the conversation with provenance and a full-size action', async () => {
    attachmentHistory = [{
      id: 'att-image', file_name: 'site-photo.jpg', file_type: 'image/jpeg', file_size_bytes: 900,
      storage_bucket: 'bob-uploads', storage_path: 'org/org-1/bob/conversation-1/site-photo.jpg',
      processing_state: 'extracted', extraction_summary: 'Detected site frontage.', confidence: 0.84,
      source_type: 'upload', source_url: null, created_at: '2026-09-02T06:01:00.000Z',
    }];

    render(<BobPanel open onClose={() => undefined} />);

    const image = await screen.findByAltText('site-photo.jpg');
    expect(image.getAttribute('src')).toBe('https://signed.example/bob-media.jpg');
    expect(screen.getByText('Original upload · Extracted')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open full-size site-photo.jpg' }).getAttribute('href')).toBe('https://signed.example/bob-media.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Open media studio' }));
    expect(await screen.findByLabelText('Bob studio')).toBeTruthy();
    expect(screen.queryByLabelText('Bob sessions')).toBeNull();
    expect(screen.queryByLabelText('Bob context panel')).toBeNull();
  });

  it('renders governed persisted draft content in Studio instead of the creation receipt', async () => {
    messageHistory = [{
      id: 'message-draft', role: 'assistant', flagged: false, confidence: null,
      created_at: '2026-10-11T06:00:00.000Z',
      content: 'Created **Runtime acceptance** as a conversation-scoped draft.',
      metadata: {
        studio_artifact_type: 'document',
        studio_document_kind: 'custom_document',
        studio_artifact_title: 'Runtime acceptance',
        studio_artifact_content: '# Runtime acceptance\n\nVerified recovery evidence.',
        document_id: 'document-1',
        document_version_id: 'version-1',
      },
    }];

    render(<BobPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Open document studio'));
    fireEvent.click(screen.getByRole('button', { name: /Custom document/ }));

    const studio = await screen.findByLabelText('Bob studio');
    expect(within(studio).getAllByText('Runtime acceptance')).toHaveLength(2);
    expect(within(studio).getByText('Verified recovery evidence.')).toBeTruthy();
    expect(within(studio).queryByText(/Created Runtime acceptance as a conversation-scoped draft/)).toBeNull();
  });

  it('keeps the native file input hidden and the composer anchored', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/BobPanel.css'), 'utf8');

    expect(css).toContain('.bob-panel .sr-only');
    expect(css).toContain('flex-direction: column;');
    expect(css).toContain('flex: 1 1 auto;');
    expect(css).toContain('min-height: 0;');
    expect(css).toContain('.bob-working-panel');
  });
});
