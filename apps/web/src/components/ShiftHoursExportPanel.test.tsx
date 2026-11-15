import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShiftHoursExportPanel } from './ShiftHoursExportPanel';

const { rpc, downloadCsv } = vi.hoisted(() => ({ rpc: vi.fn(), downloadCsv: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/nztaRegister', async (original) => ({ ...await original<object>(), downloadCsv }));
const row = {
  id: 'shift-1', organization_id: 'org', officer_user_id: 'officer', staff_id: 'staff', staff_name: 'Fixture staff',
  service_type: 'guard', status: 'completed', updated_at: '2020-06-01T06:00:00Z',
  scheduled_start: '2020-05-31T21:00:00Z', scheduled_end: '2020-06-01T05:30:00Z',
  actual_start: '2020-05-31T21:00:00Z', actual_end: '2020-06-01T05:30:00Z',
  payable_start: '2020-05-31T21:00:00Z', payable_end: '2020-06-01T05:30:00Z',
  unpaid_minutes: 30, recorded_unpaid_minutes: 30, planned_unpaid_minutes: 30,
  correction_updated_at: null, correction_reason: null, hours_status: 'confirmed' as const,
  start_mismatch: false, finish_mismatch: false, unpaid_break_mismatch: false,
  source_revision: 'a'.repeat(32), review_revision: 1, review_status: 'approved' as const,
  can_edit_hours: true, can_review_hours: true, client_organization_id: 'client',
  client_name: 'Agreement client', service_agreement_id: 'agreement', location_name: 'Fixture workplace',
  client_link_problem: null, payroll_adjustment_pending: false, employee_number: 'EMP-12',
};
beforeEach(() => { rpc.mockReset(); downloadCsv.mockReset(); rpc.mockResolvedValue({ data: [row], error: null }); });
afterEach(cleanup);

it('previews real approved details and totals, rechecks before download, and never creates a paid payroll batch', async () => {
  render(<ShiftHoursExportPanel organizationId="org" from="2020-06-01" to="2020-06-02" rows={[row]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview payroll hours' }));
  expect(await screen.findByRole('table', { name: /hours export preview/i })).toBeTruthy();
  expect(screen.getByRole('cell', { name: /Fixture workplace/ })).toBeTruthy();
  expect(screen.getByText(/grand total: 8 hours/i)).toBeTruthy();
  expect(downloadCsv).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed CSV' }));
  await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
  expect(downloadCsv.mock.calls[0][1]).toContain('EMP-12');
  expect(rpc.mock.calls.every(([name]) => name === 'get_timesheet_shift_rows')).toBe(true);
});

it('does not download changed evidence until the human reviews the refreshed preview', async () => {
  render(<ShiftHoursExportPanel organizationId="org" from="2020-06-01" to="2020-06-02" rows={[row]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview payroll hours' }));
  await screen.findByRole('table');
  rpc.mockResolvedValue({ data: [{ ...row, source_revision: 'b'.repeat(32), unpaid_minutes: 60 }], error: null });
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed CSV' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/changed.*preview/i));
  expect(downloadCsv).not.toHaveBeenCalled();
  expect(screen.getByText(/grand total: 7.5 hours/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed CSV' }));
  await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
});

it('requires a real client selection, excludes employer-only columns and clears a preview when the organisation changes', async () => {
  const { rerender } = render(<ShiftHoursExportPanel organizationId="org" from="2020-06-01" to="2020-06-02" rows={[row]} clientOnly />);
  expect(screen.getByRole('button', { name: 'Preview client hours' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Client for hours export'), { target: { value: 'client' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview client hours' }));
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Download reviewed CSV' }));
  await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
  expect(downloadCsv.mock.calls[0][1]).not.toContain('EMP-12');
  rerender(<ShiftHoursExportPanel organizationId="another" from="2020-06-01" to="2020-06-02" rows={[]} clientOnly />);
  expect(screen.queryByRole('button', { name: 'Download reviewed CSV' })).toBeNull();
  expect(screen.queryByText('Fixture workplace')).toBeNull();
});

it('shows service errors rather than an empty/successful export and permits a deliberate retry', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'Hours access denied' } });
  render(<ShiftHoursExportPanel organizationId="org" from="2020-06-01" to="2020-06-02" rows={[row]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview payroll hours' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Hours access denied'));
  expect(screen.queryByRole('table')).toBeNull();
  expect(downloadCsv).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: [row], error: null });
  fireEvent.click(screen.getByRole('button', { name: 'Preview payroll hours' }));
  expect(await screen.findByRole('table')).toBeTruthy();
});

it('recovers the Finance client selector after an initial hours load failure without changing the date scope', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'Hours temporarily unavailable' } });
  render(<ShiftHoursExportPanel organizationId="org" from="2020-06-01" to="2020-06-02" clientOnly />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('temporarily unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading hours' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Agreement client' })).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('Client for hours export')).toHaveProperty('disabled', false));
  fireEvent.change(screen.getByLabelText('Client for hours export'), { target: { value: 'client' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Preview client hours' }));
  expect(await screen.findByRole('table', { name: /hours export preview/i })).toBeTruthy();
  expect(downloadCsv).not.toHaveBeenCalled();
});
