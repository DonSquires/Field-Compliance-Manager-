import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const crmPage = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('CRM payment receipts', () => {
  it('records payment evidence through the governed finance RPC', () => {
    expect(crmPage).toContain("supabase.rpc('record_payment_receipt'");
    expect(crmPage).toContain('p_payment_amount: amount');
    expect(crmPage).toContain('p_transaction_reference: paymentForm.reference.trim() || null');
    expect(crmPage).toContain('A full remaining payment settles the invoice; a partial payment leaves it open.');
  });

  it('does not use the generic lifecycle RPC to mark an invoice paid', () => {
    expect(crmPage).not.toContain("p_action: 'mark_paid'");
    expect(crmPage).toContain('Record payment receipt');
  });
});
