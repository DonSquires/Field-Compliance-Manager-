import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BobPanel } from './BobPanel';

const { mockFrom, mockInvoke } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn(),
}));
let messageHistory: Array<Record<string, unknown>> = [];

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', organizationId: 'org-1' },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    functions: { invoke: mockInvoke },
  },
}));

describe('BobPanel', () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockInvoke.mockReset();
    messageHistory = [];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: { id: 'conversation-1' }, error: null }),
                  }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'conversation-1' }, error: null }),
            }),
          }),
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

      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
      };
    });

    mockInvoke.mockResolvedValue({ data: { reply: 'ok' }, error: null });
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

    expect(screen.getByText('Governed session')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan work' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Ask Bob to plan, inspect, explain, or prepare a proposal'), { target: { value: 'Check the site status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', {
        body: {
          message: 'Check the site status',
          conversation_id: 'conversation-1',
          context: {
            agreement: { id: 'agreement-1', name: 'Site Service Agreement' },
            site: { id: 'site-1', name: 'North Plant' },
            zone: { id: 'zone-1', name: 'Zone A' },
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
    expect(screen.getByText('80% confidence')).toBeTruthy();
    expect(screen.getByText('Review the affected files before proposing a change.')).toBeTruthy();
  });
});
