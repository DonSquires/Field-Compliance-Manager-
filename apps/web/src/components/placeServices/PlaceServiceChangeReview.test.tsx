import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlaceServiceChangeReview } from './PlaceServiceChangeReview';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc } }));

const terms = {
  anchor: { site_id: null, zone_id: 'zone' }, module_key: 'patrol',
  days: { mode: 'fixed', weekdays: [1, 2, 3, 4, 5] }, window: { mode: 'fixed', start: '22:00', end: '06:00' },
  months: [], visits_per_shift: 1, min_gap_minutes: 0, dwell_minutes: 10, checks: ['gate_check'], officer_instructions: null,
};
const action = {
  id: 'action', triggered_by: 'requester', can_decide: true, status: 'pending',
  proposed_payload: { version_id: 'version', location_id: 'loc', change_kind: 'update', effective_from: '2026-11-20', terms },
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_place_services') return { data: { check_types: [{ check_key: 'gate_check', label: 'Gate check' }], seasons: [] }, error: null };
    if (name === 'decide_place_service_change') return { data: { version_id: 'version', status: 'approved', applied_effective_from: '2026-11-20', delivery_schedule_id: 'schedule' }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(cleanup);

describe('place service change review', () => {
  it('summarises the proposed terms in plain words', async () => {
    render(<PlaceServiceChangeReview action={action} currentUserId="approver" onDecided={() => undefined} />);
    expect(await screen.findByText('Mon–Fri · 22:00–06:00 · 1 visit · Gate check')).toBeTruthy();
    expect(screen.getByText(/Update from 2026-11-20/)).toBeTruthy();
  });

  it('does not ask for another approver once the requester\'s change is decided', async () => {
    render(<PlaceServiceChangeReview action={{ ...action, triggered_by: 'approver', status: 'approved' }} currentUserId="approver" onDecided={() => undefined} />);
    expect(await screen.findByText(/Update from 2026-11-20/)).toBeTruthy();
    expect(screen.queryByText('Another administrator must approve this')).toBeNull();
  });

  it('approves through the place decision RPC with the reason and reports when it applies', async () => {
    const onDecided = vi.fn();
    render(<PlaceServiceChangeReview action={action} currentUserId="approver" onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve change' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Matches the client request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('decide_place_service_change', expect.objectContaining({
      p_version_id: 'version', p_decision: 'approve', p_reason: 'Matches the client request',
    })));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('Change approved. It applies from 2026-11-20.'));
  });

  it('requires a reason before rejecting', async () => {
    render(<PlaceServiceChangeReview action={action} currentUserId="approver" onDecided={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject change' }));
    expect((screen.getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retries a failed decision with the same request ID', async () => {
    let calls = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: { check_types: [], seasons: [] }, error: null };
      calls += 1;
      return calls === 1 ? { data: null, error: { message: 'Network lost' } }
        : { data: { version_id: 'version', status: 'rejected', applied_effective_from: null, delivery_schedule_id: null }, error: null };
    });
    render(<PlaceServiceChangeReview action={action} currentUserId="approver" onDecided={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject change' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Wrong days' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Network lost');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(calls).toBe(2));
    const ids = rpc.mock.calls.filter(([name]) => name === 'decide_place_service_change').map(([, args]) => args.p_client_request_id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('tells the requester another administrator must approve', async () => {
    render(<PlaceServiceChangeReview action={action} currentUserId="requester" onDecided={() => undefined} />);
    expect(await screen.findByText('Another administrator must approve this')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve change' })).toBeNull();
  });

  it('lets the requester withdraw their own pending change without a reason', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: { check_types: [], seasons: [] }, error: null };
      return { data: { version_id: 'version', status: 'withdrawn', applied_effective_from: null, delivery_schedule_id: null }, error: null };
    });
    const onDecided = vi.fn();
    render(<PlaceServiceChangeReview action={action} currentUserId="requester" onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw change' }));
    expect(screen.getByLabelText('Reason (optional)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('decide_place_service_change', expect.objectContaining({
      p_version_id: 'version', p_decision: 'withdraw', p_reason: '',
    })));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith('Change withdrawn. The current service stays as it is.'));
  });

  it('does not offer withdrawal to another administrator', async () => {
    render(<PlaceServiceChangeReview action={action} currentUserId="approver" onDecided={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Approve change' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw change' })).toBeNull();
  });
});
