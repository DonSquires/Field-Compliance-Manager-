import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', organizationId: 'org-1' } }),
}));

vi.mock('../lib/supabase', () => {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  return {
    supabase: {
      from: () => ({
        select: () => ({ order: () => ({ limit: () => mocks.load() }) }),
        update: () => ({ in: () => ({ is: () => ({ select: () => mocks.markRead() }) }) }),
      }),
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  };
});

import { NotificationCenter } from './NotificationCenter';

const unreadNotification = {
  id: 'notification-1',
  organization_id: 'org-1',
  category: 'roster',
  severity: 'info',
  title: 'Shift updated',
  body: 'Your shift has changed.',
  link_page: 'schedule',
  link_payload: null,
  read_at: null,
  created_at: '2026-01-01T00:00:00Z',
};

async function openNotification() {
  fireEvent.click(await screen.findByTitle('1 unread notifications'));
  fireEvent.click(await screen.findByRole('button', { name: /Shift updated/ }));
}

describe('NotificationCenter navigation', () => {
  beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue({ data: [unreadNotification], error: null });
    mocks.markRead.mockReset().mockResolvedValue({ data: [{ id: 'notification-1' }], error: null });
  });
  afterEach(cleanup);

  it('keeps an unread notification when navigation is cancelled', async () => {
    const beforeNavigate = vi.fn(() => false);
    const navigate = vi.fn();
    render(<NotificationCenter onBeforeNavigate={beforeNavigate} onNavigate={navigate} />);

    await openNotification();

    expect(beforeNavigate).toHaveBeenCalledWith(unreadNotification);
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTitle('1 unread notifications')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
  });

  it('preserves existing callers without a guard: mark read, navigate, and close', async () => {
    const navigate = vi.fn();
    render(<NotificationCenter onNavigate={navigate} />);

    await openNotification();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(unreadNotification));
    expect(mocks.markRead).toHaveBeenCalledOnce();
    expect(mocks.markRead.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  it('does not navigate when saving read status fails', async () => {
    mocks.markRead.mockResolvedValue({ data: null, error: new Error('Read status failed') });
    const navigate = vi.fn();
    render(<NotificationCenter onBeforeNavigate={() => true} onNavigate={navigate} />);

    await openNotification();

    expect((await screen.findByRole('alert')).textContent).toContain('Read status failed');
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTitle('1 unread notifications')).toBeTruthy();
  });
});
