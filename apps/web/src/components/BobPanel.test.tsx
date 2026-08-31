import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BobPanel } from './BobPanel';

const { mockFrom, mockInvoke, mockUpload, mockRemove, mockRpc, mockConversationUpdate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn(),
  mockUpload: vi.fn(),
  mockRemove: vi.fn(),
  mockRpc: vi.fn(),
  mockConversationUpdate: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', organizationId: 'org-1' },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: () => ({ upload: mockUpload, remove: mockRemove }) },
    functions: { invoke: mockInvoke },
  },
}));

describe('BobPanel', () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockInvoke.mockReset();
    mockUpload.mockReset();
    mockRemove.mockReset();
    mockRpc.mockReset();
    mockConversationUpdate.mockReset();
    mockUpload.mockResolvedValue({ error: null });
    mockRemove.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockConversationUpdate.mockReturnValue({ eq: async () => ({ data: null, error: null }) });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: [{ id: 'conversation-1', title: 'Session', updated_at: '2026-08-31T00:00:00Z' }], error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'conversation-1' }, error: null }),
            }),
          }),
          update: mockConversationUpdate,
        };
      }

      if (table === 'bob_attachments') {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }

      if (table === 'bob_messages') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: [], error: null }),
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

    fireEvent.change(screen.getByPlaceholderText('Message Bob…'), { target: { value: 'Check the site status' } });
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
          },
        },
      });
    });
  });

  it('uploads files, registers Bob attachments, and sends them with the chat turn', async () => {
    const insertedAttachments: Array<Record<string, unknown>> = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: [{ id: 'conversation-1', title: 'Session', updated_at: '2026-08-31T00:00:00Z' }], error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'conversation-1', title: 'Session', updated_at: '2026-08-31T00:00:00Z' }, error: null }) }) }),
          update: mockConversationUpdate,
        };
      }
      if (table === 'bob_messages') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
      }
      if (table === 'bob_attachments') {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            insertedAttachments.push(...rows);
            return { data: null, error: null };
          },
        };
      }
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
    });

    const { container } = render(<BobPanel open onClose={() => undefined} />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('bob_conversations'));

    const file = new File(['hello'], 'evidence.txt', { type: 'text/plain' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('Message Bob…'), { target: { value: 'Read this file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(insertedAttachments[0]).toMatchObject({
      organization_id: 'org-1',
      conversation_id: 'conversation-1',
      uploaded_by: 'user-1',
      file_name: 'evidence.txt',
      file_type: 'text/plain',
      storage_bucket: 'bob-uploads',
      purpose: 'document_intake',
      processing_state: 'pending',
    });
    expect(mockInvoke).toHaveBeenCalledWith('onspace-ai-chat', {
      body: expect.objectContaining({
        message: 'Read this file',
        conversation_id: 'conversation-1',
        attachments: [expect.objectContaining({ name: 'evidence.txt', type: 'text/plain', storage_bucket: 'bob-uploads' })],
      }),
    });
  });

  it('surfaces pending approvals and opens the approval queue', async () => {
    const openApprovals = vi.fn();
    mockRpc.mockResolvedValue({ data: [{ can_decide: true }, { can_decide: false }], error: null });

    render(<BobPanel open onClose={() => undefined} onOpenApprovals={openApprovals} />);

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_approvals_activity', {
      p_limit: 25,
      p_offset: 0,
      p_statuses: ['pending'],
      p_action_types: null,
    }));

    fireEvent.click(screen.getByRole('button', { name: '1/2' }));
    expect(openApprovals).toHaveBeenCalledTimes(1);
  });

  it('removes uploaded bytes when Bob attachment registration fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'bob_conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: [{ id: 'conversation-1', title: 'Session', updated_at: '2026-08-31T00:00:00Z' }], error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'conversation-1', title: 'Session', updated_at: '2026-08-31T00:00:00Z' }, error: null }) }) }),
          update: mockConversationUpdate,
        };
      }
      if (table === 'bob_messages') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
      }
      if (table === 'bob_attachments') {
        return { insert: async () => ({ data: null, error: new Error('metadata failed') }) };
      }
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
    });

    const { container } = render(<BobPanel open onClose={() => undefined} />);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('bob_conversations'));

    const file = new File(['hello'], 'bad.txt', { type: 'text/plain' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
    expect(mockInvoke).not.toHaveBeenCalledWith('onspace-ai-chat', expect.anything());
  });

  it('renames a default session from the first useful message', async () => {
    render(<BobPanel open onClose={() => undefined} />);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('bob_conversations'));

    fireEvent.change(screen.getByPlaceholderText('Message Bob…'), { target: { value: 'Investigate roster export failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockConversationUpdate).toHaveBeenCalledWith({ title: 'Investigate roster export failure' }));
  });
});
