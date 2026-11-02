import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimesheetWorkEntry } from '../../mobile/src/lib/officerTimesheetWork';

const mocked = vi.hoisted(() => ({
  loadWork: vi.fn(), submit: vi.fn(), read: vi.fn(), staff: vi.fn(), staffScope: vi.fn(), timesheetScope: vi.fn(), staffIds: vi.fn(),
}));
vi.mock('../../mobile/src/lib/officerTimesheetWork', () => ({
  loadOfficerTimesheetWork: mocked.loadWork,
  submitOfficerTimesheetFromWork: mocked.submit,
}));
vi.mock('../../mobile/src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => table === 'staff_profiles'
      ? { select: () => ({ eq: (column: string, value: string) => { mocked.staffScope(column, value); return { or: mocked.staff }; } }) }
      : { select: () => ({ eq: (column: string, value: string) => {
        mocked.timesheetScope(column, value);
        return { in: (field: string, ids: string[]) => { mocked.staffIds(field, ids); return { order: () => ({ limit: mocked.read }) }; } };
      } }) },
  },
}));
vi.mock('../../mobile/src/lib/userFacingError', () => ({ userFacingError: (_error: unknown, message: string) => message }));

import { OfficerTimesheetPanel } from '../../mobile/src/components/OfficerTimesheetPanel';

const work = (label: string, minutes: number): TimesheetWorkEntry[] => [{
  source_type: 'shift',
  source_id: 'shift',
  work_status: 'completed',
  started_at: '2026-08-26T08:00:00Z',
  ended_at: '2026-08-26T16:00:00Z',
  calculated_minutes: minutes,
  label,
  metadata: {},
}];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.staff.mockResolvedValue({ data: [{ id: 'staff' }], error: null });
  mocked.read.mockResolvedValue({ data: [], error: null });
  mocked.loadWork.mockResolvedValue(work('Initial patrol', 480));
});
afterEach(cleanup);

function openPeriod(start: string, end: string) {
  render(<OfficerTimesheetPanel officerId="officer" organizationId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Timesheets' }));
  fireEvent.change(screen.getByLabelText('Period start'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('Period end'), { target: { value: end } });
}

describe('mobile timesheet work preview', () => {
  it('does not show or submit a late result for another period', async () => {
    const earlier = deferred<TimesheetWorkEntry[]>();
    mocked.loadWork.mockImplementation((start: string) =>
      start === '2026-08-25' ? earlier.promise : Promise.resolve(work('Current patrol', 120)));
    openPeriod('2026-08-25', '2026-08-29');
    await waitFor(() => expect(mocked.loadWork).toHaveBeenCalledWith('2026-08-25', '2026-08-29'));
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-08-26' } });
    await screen.findByText(/Current patrol/);
    await act(async () => earlier.resolve(work('Earlier patrol', 60)));
    expect(screen.queryByText(/Earlier patrol/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not reuse a preview after the officer organisation changes', async () => {
    const newOrganization = deferred<TimesheetWorkEntry[]>();
    mocked.loadWork.mockResolvedValueOnce(work('Original patrol', 480)).mockReturnValueOnce(newOrganization.promise);
    const { rerender } = render(<OfficerTimesheetPanel officerId="officer" organizationId="org" />);
    fireEvent.click(screen.getByRole('button', { name: 'Timesheets' }));
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-08-26' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-08-29' } });
    await screen.findByText(/Original patrol/);
    rerender(<OfficerTimesheetPanel officerId="officer" organizationId="another-org" />);
    await waitFor(() => expect(mocked.loadWork).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Original patrol/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => newOrganization.resolve(work('New patrol', 120)));
    await screen.findByText(/New patrol/);
  });

  it('does not show a late timesheet list from another organisation', async () => {
    const earlier = deferred<{ data: Array<Record<string, unknown>>; error: null }>();
    mocked.read.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ data: [{
      id: 'new-sheet', period_start: '2026-09-01', period_end: '2026-09-07', scheduled_hours: 8,
      actual_hours: 8, overtime_hours: 0, status: 'submitted', review_notes: null,
    }], error: null });
    const { rerender } = render(<OfficerTimesheetPanel officerId="officer" organizationId="org" />);
    fireEvent.click(screen.getByRole('button', { name: 'Timesheets' }));
    await waitFor(() => expect(mocked.read).toHaveBeenCalledTimes(1));
    rerender(<OfficerTimesheetPanel officerId="officer" organizationId="another-org" />);
    await screen.findByText(/2026-09-01 to 2026-09-07.*submitted/);
    await act(async () => earlier.resolve({ data: [{
      id: 'old-sheet', period_start: '2026-08-01', period_end: '2026-08-07', scheduled_hours: 8,
      actual_hours: 8, overtime_hours: 0, status: 'submitted', review_notes: null,
    }], error: null }));
    expect(screen.queryByText(/2026-08-01 to 2026-08-07/)).toBeNull();
    expect(screen.getByText(/2026-09-01 to 2026-09-07.*submitted/)).toBeTruthy();
  });

  it('requires a valid date and a successful preview, with a retry after failure', async () => {
    mocked.loadWork.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(work('Retried patrol', 480));
    openPeriod('2026-02-31', '2026-08-29');
    expect(mocked.loadWork).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter valid dates/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-08-26' } });
    await screen.findByText(/Could not load finished work/);
    expect(screen.queryByText(/Derived work:/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry work' }));
    await screen.findByText(/Retried patrol/);
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('requires the recent timesheet list before submission', async () => {
    mocked.read.mockResolvedValueOnce({ data: null, error: new Error('Unavailable') });
    openPeriod('2026-08-26', '2026-08-29');
    await screen.findByText(/Initial patrol/);
    await screen.findByText('Timesheets could not be loaded.');
    const submit = screen.getByRole('button', { name: 'Submit derived hours' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('No timesheets.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh timesheet list' }));
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  });

  it('scopes a linked staff profile and its timesheets to the officer organisation', async () => {
    mocked.staff.mockResolvedValue({ data: [{ id: 'linked-staff' }], error: null });
    mocked.read.mockResolvedValue({ data: [{
      id: 'sheet', period_start: '2026-08-24', period_end: '2026-08-29', scheduled_hours: 8,
      actual_hours: 8, overtime_hours: 0, status: 'rejected', review_notes: null,
    }], error: null });
    openPeriod('2026-08-26', '2026-08-29');
    await screen.findByText(/2026-08-24 to 2026-08-29.*rejected/);
    expect(mocked.staffScope).toHaveBeenCalledWith('organization_id', 'org');
    expect(mocked.staff).toHaveBeenCalledWith('user_id.eq.officer,id.eq.officer');
    expect(mocked.timesheetScope).toHaveBeenCalledWith('organization_id', 'org');
    expect(mocked.staffIds).toHaveBeenCalledWith('staff_id', ['linked-staff']);
  });

  it('does not send when no staff profile is linked', async () => {
    mocked.staff.mockResolvedValue({ data: [], error: null });
    openPeriod('2026-08-26', '2026-08-29');
    await screen.findByText('No staff profile is linked to your account. Contact payroll.');
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocked.read).not.toHaveBeenCalled();
  });

  it('does not preview or send without an organisation', async () => {
    render(<OfficerTimesheetPanel officerId="officer" organizationId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Timesheets' }));
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-08-26' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-08-29' } });
    await screen.findByText('Organisation access could not be confirmed. Timesheets are unavailable.');
    expect(mocked.loadWork).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Submit derived hours' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reuses a failed submission identity only for the same inputs', async () => {
    mocked.submit.mockRejectedValueOnce(new Error('Unavailable')).mockRejectedValueOnce(new Error('Unavailable'));
    mocked.submit.mockResolvedValue({ id: 'abababab-abab-4bab-8bab-abababababab', actual_hours: 8, source_count: 1 });
    openPeriod('2026-08-26', '2026-08-29');
    await screen.findByText(/Initial patrol/);
    const submit = screen.getByRole('button', { name: 'Submit derived hours' });
    fireEvent.click(submit);
    await screen.findByText(/Timesheet was not confirmed/);
    fireEvent.click(submit);
    await waitFor(() => expect(mocked.submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Payroll review notes'), { target: { value: 'Revised note' } });
    fireEvent.click(submit);
    await waitFor(() => expect(mocked.submit).toHaveBeenCalledTimes(3));
    expect(mocked.submit.mock.calls[1][0]).toBe(mocked.submit.mock.calls[0][0]);
    expect(mocked.submit.mock.calls[2][0]).not.toBe(mocked.submit.mock.calls[0][0]);
  });
});
