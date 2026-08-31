import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BuilderControlRoomPage from './BuilderControlRoomPage';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: mockInvoke,
    },
  },
}));

describe('BuilderControlRoomPage', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('shows a friendly empty-state when the builder edge function is unavailable', async () => {
    mockInvoke.mockRejectedValue(new Error('Failed to send a request to the Edge Function'));

    render(<BuilderControlRoomPage />);

    await waitFor(() => {
      expect(screen.getByText('No Builder jobs')).toBeTruthy();
    });

    expect(screen.getByText(/Builder control room is unavailable in this environment/i)).toBeTruthy();
  });
});
