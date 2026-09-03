import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BobPanel } from './BobPanel';

const { mockFrom, mockInvoke, mockStorageFrom } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn(),
  mockStorageFrom: vi.fn(),
}));
let messageHistory: Array<Record<string, unknown>> = [];
let attachmentHistory: Array<Record<string, unknown>> = [];
let conversationList: Array<Record<string, unknown>> = [];

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', organizationId: 'org-1' },
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
    });
  });

  it('passes the live relationship context to Bob when sending a message', async () => {
    render(
      <BobPanel
        open
        onClose={() => undefined}
        context={{
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
          message: 'Check the site status',
          conversation_id: 'conversation-1',
          attachments: [],
          context: {
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
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('80% confidence')).toBeTruthy();
    expect(screen.getByText('Review the affected files before proposing a change.')).toBeTruthy();
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

  it('renders durable evidence processing states from bob_attachments', async () => {
    attachmentHistory = [
      { id: 'att-1', file_name: 'agreement.pdf', file_type: 'application/pdf', file_size_bytes: 1200, processing_state: 'processing', extraction_summary: null, confidence: null, created_at: '2026-09-02T06:00:00.000Z' },
      { id: 'att-2', file_name: 'site-photo.jpg', file_type: 'image/jpeg', file_size_bytes: 900, processing_state: 'extracted', extraction_summary: 'Detected site frontage and signage.', confidence: 0.84, created_at: '2026-09-02T06:01:00.000Z' },
      { id: 'att-3', file_name: 'unclear-audio.webm', file_type: 'audio/webm', file_size_bytes: 700, processing_state: 'manual_review_required', extraction_summary: 'Audio quality needs review.', confidence: 0.42, created_at: '2026-09-02T06:02:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('agreement.pdf')).toBeTruthy();
    expect(screen.getByText('Reading/OCR')).toBeTruthy();
    expect(screen.getByText('site-photo.jpg')).toBeTruthy();
    expect(screen.getByText('Extracted · 84% confidence')).toBeTruthy();
    expect(screen.getByText('Detected site frontage and signage.')).toBeTruthy();
    expect(screen.getByText('unclear-audio.webm')).toBeTruthy();
    expect(screen.getByText('Needs review · 42% confidence')).toBeTruthy();
    expect(screen.getByText('Using app data')).toBeTruthy();
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

    expect(await screen.findAllByText('Draft prepared')).toHaveLength(2);
    expect(screen.getByText('Governed proposal')).toBeTruthy();
    expect(screen.getByText('Evidence')).toBeTruthy();
    expect(screen.getByText('Next action')).toBeTruthy();
    expect(screen.getByText('Review the approval item before applying it.')).toBeTruthy();
  });

  it('shows explicit activity state and truthful evidence intake availability', async () => {
    render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Idle')).toBeTruthy();
    expect(screen.getByText('Ready for input. No Bob work is running.')).toBeTruthy();
    expect(screen.getByText(/PDF, DOCX, CSV\/XLSX, TXT, JSON, images, audio, and video up to 48 MB each/)).toBeTruthy();
    expect(screen.getByLabelText('Attach files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Hold to talk' }));
    expect(await screen.findByText('Stop recording')).toBeTruthy();
    expect(screen.getByText('Bob is listening')).toBeTruthy();
    expect(screen.getByText('Recording voice note')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Stop voice capture'));

    await waitFor(() => {
      expect(screen.getByText(/voice-note-.*\.webm/)).toBeTruthy();
      expect(screen.getByText('queued')).toBeTruthy();
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

    expect(await screen.findAllByText('Failed/paused')).toHaveLength(2);
    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(screen.getAllByText('Bob recorded a failed or flagged operation for review.')).toHaveLength(2);
  });

  it('can expand from compact chat into the Bob workspace surface', async () => {
    const { container } = render(<BobPanel open onClose={() => undefined} />);

    expect(await screen.findByLabelText('Open full workspace')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Open full workspace'));

    expect(container.querySelector('.bob-panel')?.className).toContain('is-expanded');
    expect(screen.getByLabelText('Use compact panel')).toBeTruthy();
  });

  it('shows session history and a context panel in the expanded workspace', async () => {
    setViewport(1400);
    conversationList = [
      { id: 'conversation-1', title: 'Zone compliance review', created_at: '2026-09-02T05:00:00.000Z', updated_at: '2026-09-02T06:00:00.000Z' },
      { id: 'conversation-2', title: 'Roster gap analysis', created_at: '2026-08-20T05:00:00.000Z', updated_at: '2026-08-20T06:00:00.000Z' },
    ];

    render(<BobPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByLabelText('Open full workspace'));

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
    fireEvent.click(await screen.findByLabelText('Open full workspace'));

    fireEvent.change(await screen.findByLabelText('Search chats'), { target: { value: 'roster' } });

    expect(screen.queryByText('Zone compliance review')).toBeNull();
    expect(screen.getByText('Roster gap analysis')).toBeTruthy();
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

  it('keeps the native file input hidden and the composer anchored', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/BobPanel.css'), 'utf8');

    expect(css).toContain('.bob-panel .sr-only');
    expect(css).toContain('flex-direction: column;');
    expect(css).toContain('flex: 1 1 auto;');
    expect(css).toContain('min-height: 0;');
    expect(css).toContain('.bob-working-panel');
  });
});
