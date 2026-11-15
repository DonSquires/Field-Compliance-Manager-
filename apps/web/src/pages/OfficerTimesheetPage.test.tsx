import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimesheetWorkEntry } from '../lib/officerTimesheetWork';

const mocked = vi.hoisted(() => ({
  loadWork: vi.fn(),
  submit: vi.fn(),
  resubmit: vi.fn(),
  read: vi.fn(),
  staff: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  mocked.staff.mockResolvedValue({ data: [{ id: 'staff' }], error: null });
  mocked.loadWork.mockResolvedValue(work('Initial patrol', 480));
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
  it('shows approve, cancel, and edit actions on the relevant timesheets and renders totals', async () => {
    render(<OfficerTimesheetPage />);

    const pendingPeriod = await screen.findByText('8/24/2026 – 8/30/2026');
    const approvedPeriod = screen.getByText('8/17/2026 – 8/23/2026');
    const rejectedPeriod = screen.getByText('8/10/2026 – 8/16/2026');
    const pendingRow = pendingPeriod.closest('tr');
    const approvedRow = approvedPeriod.closest('tr');
    const rejectedRow = rejectedPeriod.closest('tr');

    expect(pendingRow).not.toBeNull();
    expect(approvedRow).not.toBeNull();
    expect(rejectedRow).not.toBeNull();
    expect(withinRowButtons(pendingRow as HTMLElement)).toContain('Approve');
    expect(withinRowButtons(pendingRow as HTMLElement)).not.toContain('Edit');
    expect(withinRowButtons(approvedRow as HTMLElement)).toContain('Cancel');
    expect(withinRowButtons(approvedRow as HTMLElement)).not.toContain('Edit');
    expect(withinRowButtons(approvedRow as HTMLElement)).not.toContain('Approve');
    expect(withinRowButtons(rejectedRow as HTMLElement)).toContain('Edit');

    expect(screen.getByText(/Total hours worked:/i).closest('.totals')?.textContent).toContain('Total hours worked: 23.25 h');
    expect(screen.getByText(/Total paid hours:/i).closest('.totals')?.textContent).toContain('Total paid hours: 24.50 h');

    fireEvent.click(within(rejectedRow as HTMLElement).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-08-10'));
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-08-16');
  });
});

function withinRowButtons(row: HTMLElement) {
  return [...row.querySelectorAll('button')].map((button) => button.textContent ?? '');
}
