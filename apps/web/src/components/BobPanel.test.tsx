import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BobPanel } from './BobPanel';
import { extractMermaidDiagrams } from './BobStudio';

const { mockFrom, mockInvoke, mockStorageFrom } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn(),
  mockStorageFrom: vi.fn(),
}));
let messageHistory: Array<Record<string, unknown>> = [];
let attachmentHistory: Array<Record<string, unknown>> = [];
let conversationList: Array<Record<string, unknown>> = [];
let auditHistory: Array<Record<string, unknown>> = [];
let governedActionHistory: Array<Record<string, unknown>> = [];
let turnRunHistory: Array<Record<string, unknown>> = [];
let profileRole = 'grand_master';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', organizationId: 'org-1', role: profileRole },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    functions: { invoke: mockInvoke },
    storage: { from: mockStorageFrom },
  },
}));

describe('BobPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setViewport = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  };

  beforeEach(() => {
    mockFrom.mockReset();
    mockInvoke.mockReset();
    mockStorageFrom.mockReset();
    messageHistory = [];
    attachmentHistory = [];
    conversationList = [];
    auditHistory = [];
    governedActionHistory = [];
    turnRunHistory = [];
    profileRole = 'grand_master';

    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        // limit() is awaited directly by the session list and unwrapped by maybeSingle() for the active session.
        const limitResult = {
          maybeSingle: async () => ({ data: { id: 'conversation-1' }, error: null }),
          then: (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: conversationList, error: null }),
        };
        const query = {
          eq: () => query,
          order: () => ({ limit: () => limitResult }),
        };
        return {
          select: () => query,
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'conversation-1' }, error: null }),
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

      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
      };
    });

    mockInvoke.mockResolvedValue({ data: { reply: 'ok' }, error: null });
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
          },
        },
      });
    });
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
    expect(screen.getByText('Roster gap analysis')).toBeTruthy();
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
