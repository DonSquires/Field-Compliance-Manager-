import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CostOfServicePage from './CostOfServicePage';

const { auth, rpc } = vi.hoisted(() => ({
  auth: { profile: null, operatingOrganizationId: 'provider' as string | null },
  rpc: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/PatrolTravelSummary', () => ({ default: ({ title }: { title: string }) => <p>{title}: no travel recorded.</p> }));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc,
  from: () => {
    const query = { select: () => query, eq: () => query, in: () => query, order: () => Promise.resolve({ data: [], error: null }) };
    return query;
  },
} }));
afterEach(() => { cleanup(); rpc.mockReset(); });

const summary = {
  version: 1,
  window: { from: '2026-06-01', to: '2026-11-30' },
  agreements: [
    {
      agreementId: 'health', agreementName: 'Mental Health security', clientName: 'NZ Health',
      posted: { total: 0, byType: [] },
      labour: { workedShifts: 3, inProgressShifts: 0, hours: 24, postedShifts: 0, estimateNotPosted: 480, estimatedShifts: 2, rateUnresolvedShifts: 1,
        missingSteps: { noTimesheet: 3, timesheetNotApproved: 0, approvedNotPosted: 0 } },
      callouts: { completedJobs: 0, postedJobs: 0, payLineTotal: 0, notPostedPayTotal: 0, unresolvedPayLines: 0, jobsWithoutPayLines: 0 },
    },
    {
      agreementId: 'gibbons', agreementName: 'Retail callouts', clientName: 'Gibbons Property',
      posted: { total: 100, byType: [{ costType: 'labour', total: 100 }] },
      labour: { workedShifts: 0, inProgressShifts: 0, hours: 0, postedShifts: 0, estimateNotPosted: 0, estimatedShifts: 0, rateUnresolvedShifts: 0,
        missingSteps: { noTimesheet: 0, timesheetNotApproved: 0, approvedNotPosted: 0 } },
      callouts: { completedJobs: 1, postedJobs: 0, payLineTotal: 50, notPostedPayTotal: 50, unresolvedPayLines: 0, jobsWithoutPayLines: 0 },
    },
  ],
  unattributed: { workedShifts: 0, hours: 0, completedJobs: 0 },
};

const renderPage = () => render(<MemoryRouter><CostOfServicePage /></MemoryRouter>);

describe('cost of service', () => {
  it('shows posted cost, unposted estimate and the steps that block a full cost picture', async () => {
    rpc.mockResolvedValue({ data: summary, error: null });
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cost of service');
    const health = await screen.findByRole('article', { name: 'Mental Health security' });
    expect(health.textContent).toContain('Nothing posted yet');
    expect(health.textContent).toContain('$480.00');
    expect(health.textContent).toContain('3 worked shifts have no timesheet.');
    expect(health.textContent).toContain('1 shift has no applicable pay rate');
    expect(health.textContent).not.toContain('$0.00');
    const gibbons = screen.getByRole('article', { name: 'Retail callouts' });
    expect(gibbons.textContent).toContain('$100.00');
    expect(gibbons.textContent).toContain('1 completed');
    expect(screen.getByRole('link', { name: 'Fill from schedule in Timesheets' }).getAttribute('href')).toBe('/admin/people-hr?tab=timesheets');
    expect(rpc).toHaveBeenCalledWith('get_cost_of_service_summary', expect.objectContaining({ p_organization_id: 'provider' }));
    expect(screen.getByText(/Travel by month/)).toBeTruthy();
  });

  it('explains a permission denial instead of showing an empty cost', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Cost of service access required' } });
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('finance or organisation admin access');
  });

  it('says plainly when nothing happened in the window', async () => {
    rpc.mockResolvedValue({ data: { ...summary, agreements: [] }, error: null });
    renderPage();
    expect((await screen.findByText(/No worked shifts, completed callouts or posted costs/))).toBeTruthy();
  });

  it('does not imply cost data exists without organisation context', () => {
    auth.operatingOrganizationId = null;
    renderPage();
    expect(screen.getByRole('status').textContent).toContain('No organisation is in context');
    expect(rpc).not.toHaveBeenCalled();
    auth.operatingOrganizationId = 'provider';
  });
});
