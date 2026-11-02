import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WebsiteHubPage from './WebsiteHubPage';
import WebsiteStatisticsPage from './WebsiteStatisticsPage';

const mocks = vi.hoisted(() => ({
  auth: { profile: { role: 'admin' } },
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('../lib/supabase', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}));

const summary = {
  total_page_views: 8,
  daily: [{ viewed_on: '2026-11-02', page_views: 8 }],
  pages: [{ page_path: '/', page_views: 8 }],
  regions: [{ country_code: 'NZ', region_code: 'NELSON', page_views: 5 }],
};

beforeEach(() => {
  mocks.auth.profile.role = 'admin';
  mocks.from.mockReset();
  mocks.rpc.mockReset().mockResolvedValue({ data: summary, error: null });
  mocks.from.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ count: 2, error: null }),
    }),
  });
});

afterEach(cleanup);

describe('Website workspaces', () => {
  it('shows the two operational cards and navigates to the selected task', async () => {
    const onNavigate = vi.fn();
    render(<WebsiteHubPage onNavigate={onNavigate} />);
    await screen.findByText('2');
    await screen.findByText('8');
    fireEvent.click(screen.getByRole('button', { name: 'Open enquiries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open statistics' }));
    expect(onNavigate.mock.calls.map(([page]) => page)).toEqual(['website-enquiries', 'website-statistics']);
  });

  it('does not request website data for non-administrator roles', () => {
    mocks.auth.profile.role = 'officer';
    render(<WebsiteHubPage onNavigate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Only R&M administrators/ })).toBeTruthy();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('shows date-bounded statistics and a non-identifying regional view', async () => {
    const onNavigate = vi.fn();
    render(<WebsiteStatisticsPage onNavigate={onNavigate} />);
    await screen.findByRole('row', { name: 'Home 8' });
    expect(screen.getByRole('row', { name: 'NZ · NELSON 5' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(mocks.rpc.mock.calls[1][1]).toEqual(expect.objectContaining({
      p_from: expect.any(String),
      p_to: expect.any(String),
    }));
    expect(screen.getByText(/no visitor IDs/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Website' }));
    expect(onNavigate).toHaveBeenCalledWith('website');
  });

  it('withholds the statistics page from non-administrator roles', () => {
    mocks.auth.profile.role = 'officer';
    render(<WebsiteStatisticsPage onNavigate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Only R&M administrators/ })).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
