import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GrandMasterPlatformPage from './GrandMasterPlatformPage';

const { mockInvoke, mockFrom } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'grand_master' },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    functions: { invoke: mockInvoke },
  },
}));

describe('GrandMasterPlatformPage', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockFrom.mockReset();

    mockFrom.mockImplementation((table: string) => {
      if (table === 'organizations') {
        return {
          select: async () => ({ data: [{ id: 'org-1', name: 'Demo Org', organization_type: 'local_authority', status: 'active', active: true }], error: null }),
        };
      }
      if (table === 'breach_alerts') {
        return {
          select: () => ({ eq: async () => ({ count: 2, error: null }) }),
        };
      }
      if (table === 'observations') {
        return {
          select: () => ({ count: 9, error: null }),
        };
      }
      if (table === 'user_profiles') {
        return {
          select: () => ({ count: 12, error: null }),
        };
      }
      if (table === 'notifications') {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [{ id: 'n-1', category: 'system', severity: 'info', title: 'Bob online', body: 'Operational', created_at: '2026-08-31T00:00:00Z' }], error: null }),
            }),
          }),
        };
      }
      return {
        select: async () => ({ data: [], error: null }),
      };
    });

    mockInvoke.mockResolvedValue({
      data: {
        inference: { status: 'online' },
        ptt: { status: 'online' },
        bob_control_plane: { status: 'online', service: 'bob-control-plane', builderReady: true },
        supabase: { status: 'online' },
      },
      error: null,
    });
  });

  it('shows Bob control plane health from the object-shaped service summary', async () => {
    render(<GrandMasterPlatformPage />);

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run Health Check' }));

    await waitFor(() => {
      expect(screen.getByText('Bob Control Plane')).toBeTruthy();
    });

    expect(mockInvoke).toHaveBeenCalledWith('check-services-health', { body: {} });
  });
});
