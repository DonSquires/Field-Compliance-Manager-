import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompletedWorkToInvoicePanel } from './CompletedWorkToInvoicePanel';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc } }));

type Result = { data: unknown[] | null; error: { message: string } | null };
const empty: Result = { data: [], error: null };
const failed: Result = { data: null, error: { message: 'Connection unavailable' } };
const workshop: Result = {
  data: [{
    client_organization_id: 'client-1', client_name: 'Test client', order_number: 'WO-1',
    uninvoiced_total: 100, completed_at: '2026-11-01T10:00:00Z',
  }],
  error: null,
};
const otherWorkshop: Result = {
  data: [{
    client_organization_id: 'client-2', client_name: 'Other client', order_number: 'WO-2',
    uninvoiced_total: 250, completed_at: '2026-11-02T10:00:00Z',
  }],
  error: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const dispatch: Result = {
  data: [{
    client_organization_id: 'client-1', client: { name: 'Test client' },
    service_agreement_id: 'agreement-1', source_dispatch_id: 'job-1',
    line_total: 25, billing_basis: null, created_at: '2026-11-01T10:00:00Z',
    job: { client_order_reference: null },
  }],
  error: null,
};
let results: Record<string, Array<Result | Promise<Result>>>;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  results = {};
  from.mockImplementation((table: string) => {
    const finish = () => Promise.resolve(results[table]?.shift() ?? empty);
    const query = {
      select: () => query, eq: () => query, gt: () => query, is: () => query,
      limit: finish, in: finish,
    };
    return query;
  });
});
afterEach(cleanup);

describe('completed work billing availability', () => {
  it.each(['workshop_work_order_summary', 'dispatch_job_charge_lines', 'patrol_stop_charge_lines'])(
    'does not claim billing is clear when the initial %s query fails, and retries safely',
    async (table) => {
      results[table] = [failed, empty];
      render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

      expect(await screen.findByRole('heading', { name: /unable to check/i })).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toMatch(/unable to check/i);
      expect(screen.queryByText(/everything finished has been billed/i)).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(await screen.findByRole('heading', { name: /no ready-to-invoice work found/i })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('describes a successful empty ready-only query without claiming all work is billed', async () => {
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

    expect(await screen.findByRole('heading', { name: /no ready-to-invoice work found/i })).toBeTruthy();
    expect(screen.queryByText(/everything finished has been billed/i)).toBeNull();
    expect(screen.getByText(/work may still need pricing or billing setup/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
  });

  it('requires an organization before claiming a successful check', () => {
    render(<CompletedWorkToInvoicePanel organizationId={null} />);
    expect(screen.getByRole('heading', { name: /choose an organization/i })).toBeTruthy();
    expect(from).not.toHaveBeenCalled();
  });

  it('shows successful rows and creates the same draft invoice before refreshing', async () => {
    results.workshop_work_order_summary = [workshop, empty];
    rpc.mockResolvedValue({ data: { invoice_number: 'INV-TEST', total_amount: 115 }, error: null });
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

    expect(await screen.findByRole('list')).toBeTruthy();
    expect(screen.getByText('Test client')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /100.*waiting to be invoiced/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft invoice' }));

    expect(await screen.findByRole('status', { name: 'Draft invoice result' })).toHaveProperty('textContent', expect.stringContaining('INV-TEST'));
    expect(screen.getByRole('status', { name: 'Draft invoice result' }).textContent).toContain('It is a draft: check it, then send it.');
    await screen.findByRole('heading', { name: /no ready-to-invoice work found/i });
    expect(rpc).toHaveBeenCalledWith('generate_crm_invoice_from_completed_work', {
      p_client_request_id: expect.any(String), p_organization_id: 'org-1',
      p_client_organization_id: 'client-1', p_service_agreement_id: null,
      p_period_start: null, p_period_end: null,
    });
  });

  it('hides stale amounts and actions after a post-invoice refresh fails, while retaining the draft receipt', async () => {
    let finishRefresh!: (result: Result) => void;
    results.workshop_work_order_summary = [workshop, new Promise((resolve) => { finishRefresh = resolve; }), empty];
    rpc.mockResolvedValue({ data: { invoice_number: 'INV-TEST', total_amount: 115 }, error: null });
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft invoice' }));

    await screen.findByRole('heading', { name: /checking finished work/i });
    expect(screen.queryByRole('list')).toBeNull();
    finishRefresh(failed);

    await screen.findByRole('heading', { name: /unable to check/i });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('heading', { name: /waiting to be invoiced/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /no ready-to-invoice/i })).toBeNull();
    expect(screen.getByRole('status', { name: 'Draft invoice result' }).textContent).toContain('INV-TEST');

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByRole('heading', { name: /no ready-to-invoice work found/i });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('treats a commercial-model lookup failure as unavailable rather than an empty success', async () => {
    results.dispatch_job_charge_lines = [dispatch];
    results.crm_commercial_settings = [failed];
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

    await screen.findByRole('heading', { name: /unable to check/i });
    expect(screen.getByRole('alert').textContent).toContain('Billing models could not be loaded');
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('recovers from a rejected request without leaving the panel checking forever', async () => {
    from.mockImplementationOnce(() => { throw new Error('Request interrupted'); });
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

    await screen.findByRole('heading', { name: /unable to check/i });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByRole('heading', { name: /no ready-to-invoice work found/i });
  });

  it('keeps commercial blockers on loaded rows and does not offer draft creation', async () => {
    results.dispatch_job_charge_lines = [dispatch];
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);

    expect(await screen.findByRole('list')).toBeTruthy();
    expect(screen.getByText(/1 callout needs billing set in Dispatch/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fix in Dispatch first' })).toHaveProperty('disabled', true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps a failed invoice separate from a successful work check', async () => {
    results.workshop_work_order_summary = [workshop];
    rpc.mockResolvedValue({ data: null, error: { message: 'Finance administrator access required' } });
    render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft invoice' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Finance administrator access required'));
    expect(screen.getByRole('list')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /waiting to be invoiced/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create draft invoice' })).toHaveProperty('disabled', false));
  });

  it('ignores an older organization check that completes after the current organization check', async () => {
    const first = deferred<Result>();
    const second = deferred<Result>();
    results.workshop_work_order_summary = [first.promise, second.promise];
    rpc.mockResolvedValue({ data: null, error: { message: 'Draft not created' } });
    const { rerender } = render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
    rerender(<CompletedWorkToInvoicePanel organizationId="org-2" />);

    await act(async () => { second.resolve(otherWorkshop); });
    expect(await screen.findByText('Other client')).toBeTruthy();
    await act(async () => { first.resolve(workshop); });
    expect(screen.queryByText('Test client')).toBeNull();
    expect(screen.getByText('Other client')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    await screen.findByRole('alert');
    expect(rpc).toHaveBeenCalledWith('generate_crm_invoice_from_completed_work', expect.objectContaining({
      p_organization_id: 'org-2', p_client_organization_id: 'client-2',
    }));
  });

  it('does not disclose previous-organization rows or receipts before passive effects reset the check', async () => {
    const pending = deferred<Result>();
    results.workshop_work_order_summary = [workshop, workshop, pending.promise];
    rpc.mockResolvedValue({ data: { invoice_number: 'INV-ORIGINAL', total_amount: 115 }, error: null });
    let beforeEffects = '';
    function ContextProbe({ organizationId }: { organizationId: string }) {
      useLayoutEffect(() => {
        if (organizationId === 'org-2') beforeEffects = document.body.textContent ?? '';
      }, [organizationId]);
      return <CompletedWorkToInvoicePanel organizationId={organizationId} />;
    }
    const { rerender } = render(<ContextProbe organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft invoice' }));
    await screen.findByRole('list');
    expect(screen.getByText(/INV-ORIGINAL/)).toBeTruthy();
    rerender(<ContextProbe organizationId="org-2" />);

    expect(beforeEffects).not.toContain('Test client');
    expect(beforeEffects).not.toContain('INV-ORIGINAL');
    expect(beforeEffects).not.toContain('waiting to be invoiced');
    await act(async () => { pending.resolve(empty); });
  });

  it('ignores an old invoice completion without overwriting the new organization action or starting an old refresh', async () => {
    type InvoiceResult = { data: { invoice_number: string; total_amount: number }; error: null };
    const oldInvoice = deferred<InvoiceResult>();
    const currentInvoice = deferred<InvoiceResult>();
    results.workshop_work_order_summary = [workshop, otherWorkshop, empty];
    rpc.mockReturnValueOnce(oldInvoice.promise).mockReturnValueOnce(currentInvoice.promise);
    const { rerender } = render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft invoice' }));
    rerender(<CompletedWorkToInvoicePanel organizationId="org-2" />);
    await screen.findByText('Other client');
    const create = screen.getByRole('button', { name: 'Create draft invoice' });
    expect(create).toHaveProperty('disabled', false);
    fireEvent.click(create);

    await act(async () => { oldInvoice.resolve({ data: { invoice_number: 'INV-OLD', total_amount: 115 }, error: null }); });
    expect(screen.queryByText(/INV-OLD/)).toBeNull();
    expect(screen.getByText('Other client')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
    expect(from).toHaveBeenCalledTimes(6);

    await act(async () => { currentInvoice.resolve({ data: { invoice_number: 'INV-CURRENT', total_amount: 287.5 }, error: null }); });
    await screen.findByRole('heading', { name: /no ready-to-invoice/i });
    expect(screen.getByText(/INV-CURRENT/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, 'generate_crm_invoice_from_completed_work', expect.objectContaining({
      p_organization_id: 'org-1', p_client_organization_id: 'client-1',
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'generate_crm_invoice_from_completed_work', expect.objectContaining({
      p_organization_id: 'org-2', p_client_organization_id: 'client-2',
    }));
  });

  it.each([['success', workshop], ['failure', failed]] as const)(
    'ignores an already pending old post-invoice refresh %s after the organization changes',
    async (_outcome, refreshResult) => {
      const oldRefresh = deferred<Result>();
      results.workshop_work_order_summary = [workshop, oldRefresh.promise, otherWorkshop];
      rpc.mockResolvedValue({ data: { invoice_number: 'INV-OLD', total_amount: 115 }, error: null });
      const { rerender } = render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Create draft invoice' }));
      await screen.findByRole('heading', { name: /checking finished work/i });
      rerender(<CompletedWorkToInvoicePanel organizationId="org-2" />);
      await screen.findByText('Other client');

      await act(async () => { oldRefresh.resolve(refreshResult); });
      expect(screen.queryByText(/INV-OLD/)).toBeNull();
      expect(screen.queryByText('Test client')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Other client')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Create draft invoice' })).toHaveProperty('disabled', false);
    },
  );

  it('exposes loading and keeps the retry control available but disabled while a retry is pending', async () => {
    const retry = deferred<Result>();
    results.workshop_work_order_summary = [failed, retry.promise];
    const { container } = render(<CompletedWorkToInvoicePanel organizationId="org-1" />);
    await screen.findByRole('alert');
    const retryButton = screen.getByRole('button', { name: /retry finished-work check/i });
    fireEvent.click(retryButton);

    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'Finished-work check' }).textContent).toMatch(/checking finished work/i);
    expect(screen.getByRole('button', { name: /retry finished-work check/i })).toBe(retryButton);
    expect(retryButton).toHaveProperty('disabled', true);

    await act(async () => { retry.resolve(empty); });
    await screen.findByRole('heading', { name: /no ready-to-invoice/i });
    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
  });
});
