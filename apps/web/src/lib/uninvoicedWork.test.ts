import { describe, expect, it } from 'vitest';
import { describeUninvoiced, groupUninvoicedWork, invoiceBlocker } from './uninvoicedWork';

describe('groupUninvoicedWork', () => {
  it('rolls workshop orders and Extra dispatch charge lines up per client, largest first', () => {
    const rows = groupUninvoicedWork(
      [
        { client_organization_id: 'a', client_name: 'Alpha', order_number: 'WO-1', uninvoiced_total: 440, completed_at: '2026-09-10T00:00:00Z' },
        { client_organization_id: 'a', client_name: 'Alpha', order_number: 'WO-2', uninvoiced_total: 0, completed_at: '2026-09-11T00:00:00Z' },
        { client_organization_id: 'b', client_name: 'Beta', order_number: 'WO-3', uninvoiced_total: 100, completed_at: '2026-09-01T00:00:00Z' },
        { client_organization_id: null, client_name: null, order_number: 'WO-4', uninvoiced_total: 50, completed_at: null },
      ],
      [
        { client_organization_id: 'b', client_name: 'Beta', source_dispatch_id: 'j1', line_total: 38.87, created_at: '2026-08-30T00:00:00Z', billing_basis: 'extra' },
        { client_organization_id: 'b', client_name: 'Beta', source_dispatch_id: 'j1', line_total: 20, created_at: '2026-08-30T00:00:00Z', billing_basis: 'extra' },
        { client_organization_id: 'b', client_name: 'Beta', source_dispatch_id: 'j2', line_total: 10, created_at: '2026-09-02T00:00:00Z', billing_basis: 'extra' },
      ],
      [{ client_organization_id: 'a', client_name: 'Alpha', shift_stop_id: 'stop-1', line_total: 8.5, created_at: '2026-09-12T00:00:00Z' }]
    );
    expect(rows).toEqual([
      { clientId: 'a', clientName: 'Alpha', workshopOrders: 1, dispatchJobs: 0, rateCallouts: 0, patrolVisits: 1, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, total: 448.5, oldest: '2026-09-10T00:00:00Z' },
      { clientId: 'b', clientName: 'Beta', workshopOrders: 1, dispatchJobs: 2, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, total: 168.87, oldest: '2026-08-30T00:00:00Z' },
    ]);
  });

  it('never counts contracted callouts and holds unclassified ones out of the money', () => {
    const rows = groupUninvoicedWork([], [
      { client_organization_id: 'c', client_name: 'Contract only', source_dispatch_id: 'j1', line_total: 80, created_at: '2026-10-01T00:00:00Z', billing_basis: 'contract' },
      { client_organization_id: 'd', client_name: 'Mixed', source_dispatch_id: 'j2', line_total: 110, created_at: '2026-10-02T00:00:00Z', billing_basis: 'extra' },
      { client_organization_id: 'd', client_name: 'Mixed', source_dispatch_id: 'j3', line_total: 120, created_at: '2026-10-01T00:00:00Z', billing_basis: null },
      { client_organization_id: 'e', client_name: 'Undecided', source_dispatch_id: 'j4', line_total: 60, created_at: '2026-10-03T00:00:00Z', billing_basis: null },
    ]);
    expect(rows).toEqual([
      { clientId: 'd', clientName: 'Mixed', workshopOrders: 0, dispatchJobs: 1, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 1, calloutsNeedingReference: 0, total: 110, oldest: '2026-10-02T00:00:00Z' },
      { clientId: 'e', clientName: 'Undecided', workshopOrders: 0, dispatchJobs: 0, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 1, calloutsNeedingReference: 0, total: 0, oldest: null },
    ]);
    expect(invoiceBlocker(rows[0])).toBe('1 callout needs billing set in Dispatch — Contracted work (covered by the agreement price) or Extra (billed on top).');
    expect(describeUninvoiced(rows[1])).toBe('Nothing ready to bill yet');
  });

  it('bills every callout on pay as you go, do and invoice and per request agreements, and holds per request without a reference', () => {
    const rows = groupUninvoicedWork([], [
      { client_organization_id: 'p', client_name: 'Parks', source_dispatch_id: 'j1', line_total: 100, created_at: '2026-10-05T00:00:00Z', billing_basis: null, commercial_model: 'pay_as_you_go' },
      { client_organization_id: 'p', client_name: 'Parks', source_dispatch_id: 'j2', line_total: 50, created_at: '2026-10-04T00:00:00Z', billing_basis: null, commercial_model: 'do_and_invoice' },
      { client_organization_id: 'r', client_name: 'Dam', source_dispatch_id: 'j3', line_total: 60, created_at: '2026-10-03T00:00:00Z', billing_basis: null, commercial_model: 'per_request', client_reference: 'PO-42' },
      { client_organization_id: 'r', client_name: 'Dam', source_dispatch_id: 'j4', line_total: 70, created_at: '2026-10-02T00:00:00Z', billing_basis: null, commercial_model: 'per_request', client_reference: '  ' },
      { client_organization_id: 'f', client_name: 'Forest', source_dispatch_id: 'j5', line_total: 90, created_at: '2026-10-01T00:00:00Z', billing_basis: null, commercial_model: 'fixed_price_with_extras' },
    ]);
    expect(rows).toEqual([
      { clientId: 'p', clientName: 'Parks', workshopOrders: 0, dispatchJobs: 0, rateCallouts: 2, patrolVisits: 0, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, total: 150, oldest: '2026-10-04T00:00:00Z' },
      { clientId: 'r', clientName: 'Dam', workshopOrders: 0, dispatchJobs: 0, rateCallouts: 1, patrolVisits: 0, calloutsNeedingBilling: 0, calloutsNeedingReference: 1, total: 60, oldest: '2026-10-03T00:00:00Z' },
      { clientId: 'f', clientName: 'Forest', workshopOrders: 0, dispatchJobs: 0, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 1, calloutsNeedingReference: 0, total: 0, oldest: null },
    ]);
    expect(describeUninvoiced(rows[0])).toBe('2 callouts at agreed rates finished and not yet billed · oldest ' + new Date('2026-10-04T00:00:00Z').toLocaleDateString('en-NZ'));
    expect(invoiceBlocker(rows[0])).toBeNull();
    expect(invoiceBlocker(rows[1])).toBe("1 per-request callout needs the client's request or PO reference in Dispatch.");
    expect(invoiceBlocker(rows[2])).toMatch(/^1 callout needs billing set in Dispatch/);
  });

  it('describes the waiting work in plain language', () => {
    expect(describeUninvoiced({ clientId: 'b', clientName: 'Beta', workshopOrders: 1, dispatchJobs: 2, rateCallouts: 0, patrolVisits: 1, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, total: 168.87, oldest: null })).toBe('1 workshop job and 2 Extra callouts and 1 patrol visit finished and not yet billed');
    expect(describeUninvoiced({ clientId: 'a', clientName: 'Alpha', workshopOrders: 3, dispatchJobs: 0, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, total: 1, oldest: null })).toBe('3 workshop jobs finished and not yet billed');
    expect(invoiceBlocker({ clientId: 'a', clientName: 'Alpha', workshopOrders: 3, dispatchJobs: 0, rateCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 2, calloutsNeedingReference: 0, total: 1, oldest: null })).toMatch(/^2 callouts need billing set/);
  });
});
