import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('VITE_BOB_CONTROL_PLANE_URL', 'http://127.0.0.1:8080');
    vi.stubEnv('VITE_BOB_ADMIN_TOKEN', 'test-admin-token');

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

  it('runs a live browser check through the Bob control-room relay', async () => {
    mockInvoke.mockImplementation(async (name: string, payload?: { body?: Record<string, unknown> }) => {
      if (name === 'check-services-health') return { data: { bob_control_plane: { status: 'online', service: 'bob-control-plane', builderReady: true } }, error: null };
      if (name === 'bob-builder-control-room') {
        if (payload?.body?.action === 'browser-checks') {
          return {
            data: [{ id: 'check-1', appUrl: 'http://127.0.0.1:4173', checkedAt: '2026-08-31T00:00:00Z', status: 'passed', title: 'App Title', checks: ['page_load'] }],
            error: null,
          };
        }
        return {
          data: {
            ok: true,
            appUrl: 'http://127.0.0.1:4173',
            result: { status: 'passed', title: 'App Title', checks: ['page_load'] },
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    render(<GrandMasterPlatformPage />);

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run Browser Check' }));

    await waitFor(() => {
      expect(screen.getByText('Live app check')).toBeTruthy();
    });

    expect(mockInvoke).toHaveBeenCalledWith('bob-builder-control-room', {
      body: expect.objectContaining({
        action: 'browser-check',
        appUrl: expect.any(String),
      }),
    });
  });

  it('loads persisted browser check history for the evidence trail', async () => {
    mockInvoke.mockImplementation(async (name: string, payload?: { body?: Record<string, unknown> }) => {
      if (name === 'check-services-health') return { data: { bob_control_plane: { status: 'online', service: 'bob-control-plane', builderReady: true } }, error: null };
      if (name === 'bob-builder-control-room') {
        if (payload?.body?.action === 'browser-checks') {
          return {
            data: [
              { id: 'check-1', appUrl: 'http://127.0.0.1:4173', checkedAt: '2026-08-31T00:00:00Z', status: 'passed', title: 'App Title', checks: ['page_load'] },
              { id: 'check-2', appUrl: 'http://127.0.0.1:4173/health', checkedAt: '2026-08-30T00:00:00Z', status: 'failed', error: 'snapshot mismatch' },
            ],
            error: null,
          };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    render(<GrandMasterPlatformPage />);

    await waitFor(() => {
      expect(screen.getByText('Browser check history')).toBeTruthy();
    });

    expect(screen.getByText('App Title')).toBeTruthy();
  });

  it('shows a clear configuration warning when the Bob control plane is not configured', async () => {
    vi.stubEnv('VITE_BOB_CONTROL_PLANE_URL', '');
    vi.stubEnv('VITE_BOB_ADMIN_TOKEN', '');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<GrandMasterPlatformPage />);

    await waitFor(() => {
      expect(screen.getByText(/Bob control plane is not configured/i)).toBeTruthy();
    });

    const assessmentButton = screen.getByRole('button', { name: 'Run Full Assessment' });
    expect(assessmentButton).toHaveProperty('disabled', true);

    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/bob/builder/assessment-trends'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer default-token' }) }),
    );

    fetchSpy.mockRestore();
  });

  it('runs a full platform assessment with all verification profiles', async () => {
    const { fetch: originalFetch } = globalThis;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/bob/builder/self-hosted/loop')) {
        return {
          ok: true,
          json: async () => ({
            mode: 'self_hosted_bob',
            readOnly: true,
            paused: false,
            reason: 'ready_for_human_approval',
            steps: [
              { profile: 'assessment', status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '' },
              { profile: 'test', status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '' },
              { profile: 'playwright-visual-check', status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '' },
            ],
          }),
        } as any;
      }
      return originalFetch(url);
    }) as any;

    mockInvoke.mockImplementation(async (name: string, payload?: { body?: Record<string, unknown> }) => {
      if (name === 'check-services-health') return { data: { bob_control_plane: { status: 'online' } }, error: null };
      if (name === 'bob-builder-control-room') {
        if (payload?.body?.action === 'browser-checks') {
          return { data: [], error: null };
        }
      }
      return { data: null, error: null };
    });

    render(<GrandMasterPlatformPage />);

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run Full Assessment' }));

    await waitFor(() => {
      expect(screen.getByText('Latest platform assessment')).toBeTruthy();
    });

    expect(screen.getByText('assessment')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();

    globalThis.fetch = originalFetch;
  });
});
