import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CompletedWorkToInvoicePanel.tsx'), 'utf8');

describe('completed patrol work invoice handoff', () => {
  it('adds only ready, uninvoiced per-visit charge lines to the draft invoice total', () => {
    expect(source).toContain("from('patrol_stop_charge_lines')");
    expect(source).toContain(".eq('status', 'ready')");
    expect(source).toContain(".is('invoice_line_item_id', null)");
    expect(source).toContain('groupUninvoicedWork((workshopRes.data as UninvoicedWorkshopRow[]) ?? [], dispatchRows, patrolRows)');
    expect(source).toContain('priced patrol visits turn into a draft invoice per client');
  });

  it('leaves contracted callouts out and blocks invoicing until unclassified callouts are set', () => {
    expect(source).toContain(".or('billing_basis.is.null,billing_basis.eq.extra')");
    expect(source).toContain('invoiceBlocker(entry)');
    expect(source).toContain('Contracted callouts are covered by the agreement price and are not billed again');
  });
});