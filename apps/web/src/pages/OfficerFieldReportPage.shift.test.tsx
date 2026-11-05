import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  search: '', rpc: vi.fn(), queries: [] as Array<{ table: string; filters: Array<[string, unknown]>; exact: boolean }>,
  recent: [] as Array<{ id: string; service_type: string; scheduled_start: string; status: string }>,
  exact: null as { id: string; service_type: string; scheduled_start: string; status: string } | null,
  receiptShift: undefined as string | null | undefined,
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ search: state.search }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'org' } }) }));
vi.mock('../context/ServiceRelationshipContext', () => ({ useServiceRelationships: () => ({ selectedSite: null, selectedZone: null, locationStatus: 'idle' }) }));
vi.mock('../layouts/ShellLayout', () => ({ ShellLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../components/OfficerPhotoAttachments', () => ({ OfficerPhotoAttachments: ({ target }: { target: { id: string } }) => <div data-testid="photo-target">{target.id}</div> }));
vi.mock('../lib/locationAddress', () => ({ resolveAddressCandidates: vi.fn(), resolveAddressForCoordinates: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: state.rpc,
    from: (table: string) => {
      const query = { table, filters: [] as Array<[string, unknown]>, exact: false };
      state.queries.push(query);
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { query.filters.push([column, value]); return builder; },
        in: () => builder, or: () => builder, gte: () => builder, order: () => builder,
        limit: async () => ({ data: table === 'shifts' ? state.recent : [], error: null }),
        maybeSingle: async () => { query.exact = true; return { data: state.exact, error: null }; },
      };
      return builder;
    },
  },
}));
import OfficerFieldReportPage from './OfficerFieldReportPage';

const first = '10000000-0000-4000-8000-000000000001';
const requested = '10000000-0000-4000-8000-000000000002';
const older = '10000000-0000-4000-8000-000000000003';
const reportId = '20000000-0000-4000-8000-000000000001';
const shift = (id: string) => ({ id, service_type: 'static_guard', scheduled_start: '2026-11-06T00:00:00Z', status: 'in_progress' });
beforeEach(() => {
  vi.resetAllMocks(); state.queries = [];
  state.search = `?shift=${requested}`; state.recent = [shift(first), shift(requested)];
  state.exact = shift(requested); state.receiptShift = undefined;
  state.rpc.mockImplementation(async (name: string, args?: { p_shift_id: string | null }) => ({
    data: name === 'submit_officer_field_report' ? [{
      id: reportId, received_at: '2026-11-06T00:10:00Z',
      shift_id: state.receiptShift === undefined ? args?.p_shift_id : state.receiptShift,
    }] : [], error: null,
  }));
});
afterEach(cleanup);
const ready = async () => {
  await waitFor(() => expect((screen.getByLabelText('Related shift') as HTMLSelectElement).disabled).toBe(false));
  return screen.getByLabelText('Related shift') as HTMLSelectElement;
};
const fill = () => {
  fireEvent.change(screen.getByLabelText('Report title'), { target: { value: 'Synthetic shift report' } });
  fireEvent.change(screen.getByLabelText('Report description'), { target: { value: 'Synthetic report context only.' } });
};

describe('static-post report shift handoff', () => {
  it('selects only the requested assigned shift and preserves intentional changes on refresh', async () => {
    render(<OfficerFieldReportPage />);
    const select = await ready();
    expect(select.value).toBe(requested);
    expect(state.queries.find((query) => query.exact)?.filters).toEqual([
      ['id', requested], ['officer_user_id', 'officer'], ['organization_id', 'org'],
    ]);
    fireEvent.change(select, { target: { value: first } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh field reports' }));
    await ready(); expect(select.value).toBe(first);
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh field reports' }));
    await ready(); expect(select.value).toBe('');
  });
  it('loads the exact assigned older shift separately from the recent-shift window', async () => {
    state.search = `?shift=${older}`; state.exact = shift(older);
    render(<OfficerFieldReportPage />);
    expect((await ready()).value).toBe(older);
  });
  it('fails explicitly when refresh can no longer confirm the selected assigned shift', async () => {
    render(<OfficerFieldReportPage />); const select = await ready(); fill();
    state.recent = [shift(first)]; state.exact = null;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh field reports' }));
    await ready();
    expect(select.value).toBe(requested);
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
    expect((screen.getByRole('button', { name: 'Submit report' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('reinitializes context if the route changes to an invalid requested shift', async () => {
    state.search = '';
    const view = render(<OfficerFieldReportPage />);
    expect((await ready()).value).toBe(first);
    state.search = '?shift=no-request'; state.exact = null;
    view.rerender(<OfficerFieldReportPage />);
    const select = await ready();
    expect(select.value).not.toBe(first);
    expect(screen.getByRole('alert').textContent).toContain('invalid');
  });
  it.each([older, 'invalid', ''])('blocks unavailable/invalid shift context %s until the officer explicitly changes it', async (id) => {
    state.search = `?shift=${id}`; state.exact = null;
    render(<OfficerFieldReportPage />);
    const select = await ready(); fill();
    expect(select.value).not.toBe(first);
    expect(screen.getByRole('alert').textContent).toContain(id === older ? 'unavailable' : 'invalid');
    expect((screen.getByRole('button', { name: 'Submit report' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit report' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('does not confirm a mismatched shift receipt or reset retry identity, then accepts the matching retry', async () => {
    state.receiptShift = first;
    render(<OfficerFieldReportPage />); await ready(); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect((await screen.findByRole('alert')).textContent).toContain('did not confirm the selected shift');
    expect((screen.getByLabelText('Report title') as HTMLInputElement).value).toBe('Synthetic shift report');
    expect(screen.queryByTestId('photo-target')).toBeNull();
    const original = state.rpc.mock.calls.find(([name]) => name === 'submit_officer_field_report')?.[1];
    expect(original.p_shift_id).toBe(requested);
    state.receiptShift = requested;
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByTestId('photo-target')).toHaveProperty('textContent', reportId);
    await ready();
    const retries = state.rpc.mock.calls.filter(([name]) => name === 'submit_officer_field_report');
    expect(retries).toHaveLength(2);
    expect(retries[1][1].p_client_event_id).toBe(original.p_client_event_id);
    expect((screen.getByLabelText('Related shift') as HTMLSelectElement).value).toBe(requested);
  });
});
