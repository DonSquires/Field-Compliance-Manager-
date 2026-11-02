import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimesheetWorkEntry } from '../lib/officerTimesheetWork';

const mocked = vi.hoisted(() => ({ loadWork: vi.fn(), submit: vi.fn(), resubmit: vi.fn(), read: vi.fn(), staff: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'org' } }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ search: '' }) }));
vi.mock('../lib/officerTimesheetWork', () => ({
  loadOfficerTimesheetWork: mocked.loadWork,
  submitOfficerTimesheetFromWork: mocked.submit,
  resubmitRejectedTimesheetFromWork: mocked.resubmit,
}));
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => table === 'staff_profiles'
      ? { select: () => ({ eq: () => ({ or: mocked.staff }) }) }
      : { select: () => ({ eq: () => ({ in: () => ({ order: mocked.read }) }) }) },
  },
}));

import OfficerTimesheetPage from './OfficerTimesheetPage';

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
  vi.clearAllMocks();
  mocked.staff.mockResolvedValue({ data: [{ id: 'staff' }], error: null });
  mocked.read.mockResolvedValue({ data: [], error: null });
  mocked.loadWork.mockResolvedValue(work('Initial patrol', 480));
});
afterEach(cleanup);

async function choosePeriod() {
  await screen.findByText('Initial patrol');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-24' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-29' } });
  await waitFor(() => expect(mocked.loadWork).toHaveBeenCalledWith('2026-08-24', '2026-08-29'));
}

describe('timesheet work preview', () => {
  it('ignores a late result for an earlier period', async () => {
    const earlier = deferred<TimesheetWorkEntry[]>();
    mocked.loadWork.mockImplementation((start: string) => {
      if (start === '2026-08-25') return earlier.promise;
      return Promise.resolve(start === '2026-08-26' ? work('Current patrol', 120) : work('Initial patrol', 480));
    });
    render(<OfficerTimesheetPage />);
    await choosePeriod();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-25' } });
    await waitFor(() => expect(mocked.loadWork).toHaveBeenCalledWith('2026-08-25', '2026-08-29'));
    expect((screen.getByRole('button', { name: 'Send for approval' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-26' } });
    await screen.findByText('Current patrol');
    await act(async () => earlier.resolve(work('Earlier patrol', 60)));
    expect(screen.queryByText('Earlier patrol')).toBeNull();
    expect(screen.getByText('Current patrol')).toBeTruthy();
  });

  it('requires a successful retry after the selected period fails to load', async () => {
    let failed = true;
    mocked.loadWork.mockImplementation((start: string) => {
      if (start === '2026-08-26' && failed) return Promise.reject(new Error('Unavailable'));
      return Promise.resolve(start === '2026-08-26' ? work('Retried patrol', 480) : work('Initial patrol', 480));
    });
    render(<OfficerTimesheetPage />);
    await choosePeriod();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-26' } });
    await screen.findByText(/could not load.*finished work/i);
    expect(screen.queryByText('Initial patrol')).toBeNull();
    expect((screen.getByRole('button', { name: 'Send for approval' }) as HTMLButtonElement).disabled).toBe(true);
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry work preview' }));
    await screen.findByText('Retried patrol');
    expect((screen.getByRole('button', { name: 'Send for approval' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not send when no staff profile is linked', async () => {
    mocked.staff.mockResolvedValue({ data: [], error: null });
    render(<OfficerTimesheetPage />);
    await screen.findByText('No staff profile is linked to your account. Contact payroll.');
    await screen.findByText('Initial patrol');
    expect((screen.getByRole('button', { name: 'Send for approval' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocked.read).not.toHaveBeenCalled();
  });
});
