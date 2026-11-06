import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), corporate: true, failRecovery: false }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({
  profile: { id: 'admin', organizationId: 'provider', employerOrganizationId: mocked.corporate ? 'provider' : null, role: 'admin' },
  operatingOrganizationId: 'provider', operatingOrganizations: [],
}) }));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin/people-hr', search: '?tab=timesheets' }),
  useNavigate: () => vi.fn(), useHref: (path: string) => path,
}));
vi.mock('../components/RosterRulesPanel', () => ({ RosterRulesPanel: () => null }));
vi.mock('../lib/supabase', () => {
  const dataFor = (table: string) => {
    if (table === 'user_profiles') return [{ id: 'officer', display_name: 'Fixture officer', role: 'officer' }];
    if (table === 'staff_profiles') return [{ id: 'staff', user_id: 'officer', employment_type: 'permanent' }];
    if (table === 'timesheets') return [{ id: 'sheet', staff_id: 'staff', period_start: '2026-10-01', period_end: '2026-10-01',
      status: 'submitted', actual_hours: 8, overtime_hours: 0, work_derived_hours: 8, adjustment_hours: 0, revision: 3 }];
    return [];
  };
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit', 'neq', 'gte', 'lte', 'or']) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data: dataFor(table), error: null }).then(resolve, reject);
    return query;
  };
  return { supabase: { from, rpc: mocked.rpc } };
});

import RosterHRPage from './RosterHRPage';

afterEach(cleanup);
beforeEach(() => {
  mocked.corporate = true; mocked.failRecovery = false;
  mocked.rpc.mockReset();
  mocked.rpc.mockImplementation(async (name: string) => {
    if (name === 'preview_scheduled_timesheet') return { data: [{ source_type: 'roster_slot', source_id: 'slot', shift_id: 'shift',
      scheduled_start: '2026-10-01T08:00:00+13:00', scheduled_end: '2026-10-01T16:00:00+13:00',
      source_version: 'version', planned_break_minutes: 30, break_unpaid: true }], error: null };
    if (name === 'recover_scheduled_timesheet') return mocked.failRecovery
      ? { data: null, error: { message: 'Source changed. Reload preview.' } } : { data: { id: 'manual-sheet', status: 'submitted' }, error: null };
    if (name === 'correct_timesheet_pay') return { data: { id: 'sheet', status: 'submitted' }, error: null };
    if (name === 'get_timesheet_break_review') return { data: [{ shift_id: 'shift', planned_minutes: 30, taken_minutes: 0, unpaid: true, review_status: 'not_recorded' }], error: null };
    return { data: [], error: null };
  });
});

describe('admin manual payroll evidence', () => {
  it('previews explicit sources, never copies a planned break deduction, and retries with the same receipt key', async () => {
    render(<RosterHRPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover scheduled shift into timesheet' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Staff member'), { target: { value: 'staff' } });
    fireEvent.change(within(dialog).getByLabelText('Period from'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(dialog).getByLabelText('Period to (include overnight end date)'), { target: { value: '2026-10-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview scheduled rows' }));
    fireEvent.click(await within(dialog).findByRole('checkbox'));
    expect((within(dialog).getByLabelText('Evidence-confirmed unpaid break (minutes)') as HTMLInputElement).value).toBe('0');
    expect(within(dialog).getByText(/Planned break: 30 minutes/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Recovery / amendment reason and evidence'), { target: { value: 'Supervisor confirms shift' } });
    mocked.failRecovery = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save manual timesheet for review' }));
    await within(dialog).findByText('Source changed. Reload preview.');
    const first = mocked.rpc.mock.calls.find(([name]) => name === 'recover_scheduled_timesheet')![1];
    expect(first.p_rows).toEqual([expect.objectContaining({ source_type: 'roster_slot', source_id: 'slot', source_version: 'version', unpaid_break_minutes: 0 })]);
    mocked.failRecovery = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save manual timesheet for review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const requests = mocked.rpc.mock.calls.filter(([name]) => name === 'recover_scheduled_timesheet');
    expect(requests[1][1].p_client_request_id).toBe(first.p_client_request_id);
    expect(await screen.findByText(/No attendance or GPS was created/)).toBeTruthy();
  });

  it('saves only a timesheet pay override with expected revision and mandatory reason', async () => {
    render(<RosterHRPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pay code / rate' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Timesheet pay code override (blank = normal rule)'), { target: { value: 'premium' } });
    fireEvent.change(within(dialog).getByLabelText('Timesheet hourly rate override (blank = normal rule)'), { target: { value: '42.5' } });
    fireEvent.change(within(dialog).getByLabelText('Audited reason'), { target: { value: 'One-shift premium confirmed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save timesheet-only pay correction' }));
    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('correct_timesheet_pay', expect.objectContaining({
      p_timesheet_id: 'sheet', p_expected_revision: 3, p_pay_code: 'PREMIUM', p_hourly_rate: 42.5, p_reason: 'One-shift premium confirmed',
    })));
    expect(mocked.rpc.mock.calls.some(([name]) => /employment|rate_rule/.test(name))).toBe(false);
  });

  it('hides payroll-only controls from a non-employer admin but keeps break review evidence', async () => {
    mocked.corporate = false;
    render(<RosterHRPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review breaks' }));
    expect(screen.queryByRole('button', { name: 'Pay code / rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover scheduled shift into timesheet' })).toBeNull();
    expect(await screen.findByText(/missed \/ not recorded/)).toBeTruthy();
    expect(mocked.rpc).toHaveBeenCalledWith('get_timesheet_break_review', { p_timesheet_id: 'sheet' });
  });
});
