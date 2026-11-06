import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import CostOfServicePage from './CostOfServicePage';

const { auth } = vi.hoisted(() => ({ auth: { profile: null, operatingOrganizationId: 'provider' as string | null } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/PatrolTravelSummary', () => ({ default: () => <p>No travel distance has been recorded for this scope.</p> }));
vi.mock('../lib/supabase', () => ({ supabase: { from: () => {
  const query = { select: () => query, eq: () => query, in: () => query, order: () => Promise.resolve({ data: [], error: null }) };
  return query;
} } }));
afterEach(cleanup);

describe('honest cost of service boundary', () => {
  it('labels distance as recorded travel, not actual financial cost', async () => {
    render(<CostOfServicePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recorded travel');
    expect(screen.getByRole('note').textContent).toContain('Missing distance, wages or rates are not zero cost');
    expect(screen.queryByText(/\$0/)).toBeNull();
    expect(await screen.findAllByText(/No travel distance/)).toHaveLength(2);
  });
  it('does not imply cost data exists without organisation access', () => {
    auth.operatingOrganizationId = null;
    render(<CostOfServicePage />);
    expect(screen.getByRole('status').textContent).toContain('recorded travel is unavailable');
    auth.operatingOrganizationId = 'provider';
  });
});
