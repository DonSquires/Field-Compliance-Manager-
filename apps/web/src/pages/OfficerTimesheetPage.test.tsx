import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimesheetWorkEntry } from '../lib/officerTimesheetWork';

const mocked = vi.hoisted(() => ({
  loadWork: vi.fn(),
  rpc: vi.fn(),
  timesheetColumns: vi.fn(),
  read: vi.fn(),
  staff: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'org' } }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ search: '' }) }));
vi.mock('../lib/officerTimesheetWork', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/officerTimesheetWork')>(),
  loadOfficerTimesheetWork: mocked.loadWork,
}));
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: mocked.rpc,
    from: (table: string) => table === 'staff_profiles'
      ? { select: () => ({ eq: () => ({ or: mocked.staff }) }) }
      : { select: (columns: string) => {
        mocked.timesheetColumns(columns);
        return { eq: () => ({ in: () => ({ order: mocked.read }) }) };
      } },
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

beforeEach(() => {
  vi.clearAllMocks();
  mocked.staff.mockResolvedValue({ data: [{ id: 'staff' }], error: null });
  mocked.loadWork.mockResolvedValue(work('Initial patrol', 480));
  mocked.rpc.mockResolvedValue({ data: [{ id: 'sheet-rejected', actual_hours: 8, source_count: 1 }], error: null });
  mocked.read.mockResolvedValue({ data: [{
    id: 'sheet-pending',
    period_start: '2026-08-24',
    period_end: '2026-08-30',
    scheduled_hours: 8,
    work_derived_hours: 7.5,
    actual_hours: 8,
    adjustment_hours: 0,
    overtime_hours: 0,
    status: 'pending',
    review_notes: null,
    approved_at: null,
    submitted_at: '2026-08-30T09:30:00Z',
  }, {
    id: 'sheet-approved',
    period_start: '2026-08-17',
    period_end: '2026-08-23',
    scheduled_hours: 10,
    work_derived_hours: 9.25,
    actual_hours: 9.5,
    adjustment_hours: 0.25,
    overtime_hours: 1.5,
    status: 'approved',
    review_notes: 'Looks good',
    approved_at: '2026-08-31T10:00:00Z',
    submitted_at: '2026-08-30T09:30:00Z',
  }, {
    id: 'sheet-rejected',
    period_start: '2026-08-10',
    period_end: '2026-08-16',
    scheduled_hours: 8,
    work_derived_hours: 6.5,
    actual_hours: 7,
    adjustment_hours: 0.5,
    overtime_hours: 0,
    status: 'rejected',
    review_notes: 'Please correct the adjustment.',
    approved_at: null,
    submitted_at: '2026-08-23T09:30:00Z',
  }], error: null });
});

afterEach(cleanup);

describe('OfficerTimesheetPage', () => {
  it('shows only rejected Edit, preserving status, review feedback and totals', async () => {
    render(<OfficerTimesheetPage />);

    const pendingRow = (await screen.findByText('Pending')).closest('tr');
    const approvedRow = screen.getByText('Approved').closest('tr');
    const rejectedRow = screen.getByText('Sent back to you').closest('tr');

    expect(pendingRow).not.toBeNull();
    expect(approvedRow).not.toBeNull();
    expect(rejectedRow).not.toBeNull();
    expect(withinRowButtons(pendingRow as HTMLElement)).toEqual([]);
    expect(withinRowButtons(approvedRow as HTMLElement)).toEqual([]);
    expect(withinRowButtons(rejectedRow as HTMLElement)).toEqual(['Edit']);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(approvedRow as HTMLElement).getByText(/Looks good/)).toBeTruthy();
    expect(within(rejectedRow as HTMLElement).getByText(/Please correct the adjustment/)).toBeTruthy();

    expect(screen.getByText(/Total hours worked:/i).closest('.totals')?.textContent).toContain('Total hours worked: 23.25 h');
    expect(screen.getByText(/Total paid hours:/i).closest('.totals')?.textContent).toContain('Total paid hours: 24.50 h');

    fireEvent.click(within(rejectedRow as HTMLElement).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-08-10'));
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-08-16');
  });

  it.each([
    { savedAdjustment: 0, expectedAdjustment: 0 },
    { savedAdjustment: 0.5, expectedAdjustment: 0.5 },
    { savedAdjustment: null, expectedAdjustment: 0 },
    { savedAdjustment: undefined, expectedAdjustment: 0 },
  ])('submits saved adjustment $savedAdjustment unchanged after rejected Edit', async ({ savedAdjustment, expectedAdjustment }) => {
    mocked.read.mockResolvedValue({ data: [{
      id: 'sheet-rejected', period_start: '2026-08-10', period_end: '2026-08-16',
      scheduled_hours: 8, work_derived_hours: 6.5, actual_hours: 7,
      adjustment_hours: savedAdjustment, overtime_hours: 0, status: 'rejected',
      review_notes: 'Please correct the adjustment.', approved_at: null, submitted_at: null,
    }], error: null });
    render(<OfficerTimesheetPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send corrected timesheet' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send corrected timesheet' }));

    await screen.findByText(/Timesheet sent for approval:/);
    expect(mocked.rpc).toHaveBeenCalledWith('resubmit_rejected_timesheet_from_work', {
      p_timesheet_id: 'sheet-rejected', p_adjustment_hours: expectedAdjustment, p_notes: null,
    });
    expect(mocked.timesheetColumns).toHaveBeenCalledWith(expect.stringContaining('adjustment_hours'));
    expect(screen.getByRole('status').textContent).toContain('Timesheet sent for approval');
  });

  it('keeps submitted history read-only while waiting for review', async () => {
    mocked.read.mockResolvedValue({ data: [{
      id: 'sheet-submitted', period_start: '2026-08-24', period_end: '2026-08-30',
      scheduled_hours: 8, work_derived_hours: 8, actual_hours: 8, adjustment_hours: 0,
      overtime_hours: 0, status: 'submitted', review_notes: null, approved_at: null, submitted_at: null,
    }], error: null });
    render(<OfficerTimesheetPage />);

    const row = (await screen.findByText('Waiting for review')).closest('tr') as HTMLElement;
    expect(withinRowButtons(row)).toEqual([]);
  });
});

function withinRowButtons(row: HTMLElement) {
  return [...row.querySelectorAll('button')].map((button) => button.textContent ?? '');
}
