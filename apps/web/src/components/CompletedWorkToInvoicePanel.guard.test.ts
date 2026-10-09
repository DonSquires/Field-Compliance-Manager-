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
});