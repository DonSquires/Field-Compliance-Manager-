import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261014193430_harden_crm_invoice_line_mutations.sql'),
  'utf8',
);
const liveSchema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const dialog = readFileSync(resolve(process.cwd(), 'src/components/CrmInvoiceLineDialog.tsx'), 'utf8');
const crmPage = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('CRM invoice line workflow', () => {
  it('makes manual additions retry-safe and bounded', () => {
    expect(migration).toContain('invoice_line_items_manual_request_unique');
    expect(migration).toContain('l.client_request_id = p_client_request_id');
    expect(migration).toContain("'crm_invoice_line_added'");
    expect(migration).toContain("length(v_description) > 500");
    expect(migration).toContain('p_quantity * p_unit_price > 9999999999.99');
    expect(migration).toContain("'manual'");
  });

  it('keeps generated evidence lines immutable and removals retry-safe', () => {
    expect(migration).toContain("v_line.line_source <> 'manual'");
    expect(migration).toContain('Evidence-backed invoice lines cannot be removed');
    expect(migration).toContain("'crm_invoice_line_removed'");
    expect(migration).toContain("a.metadata->>'client_request_id' = p_client_request_id::text");
  });

  it('preserves the hardened authority in the live schema', () => {
    expect(liveSchema).toContain('invoice_line_items_manual_request_unique');
    expect(liveSchema).toContain('This line-add request was already applied and the original line is no longer present');
    expect(liveSchema).toContain('Evidence-backed invoice lines cannot be removed');
    expect(liveSchema).toMatch(/REVOKE ALL ON FUNCTION "public"\."add_crm_invoice_line".*FROM PUBLIC, "anon"/);
    expect(liveSchema).toMatch(/REVOKE ALL ON FUNCTION "public"\."remove_crm_invoice_line".*FROM PUBLIC, "anon"/);
  });

  it('uses governed RPCs and never writes invoice tables directly', () => {
    expect(dialog).toContain("supabase.rpc('add_crm_invoice_line'");
    expect(dialog).toContain("supabase.rpc('remove_crm_invoice_line'");
    expect(dialog).toContain("line.line_source === 'manual'");
    expect(dialog).toContain('role="alertdialog"');
    expect(dialog).not.toMatch(/from\('(invoices|invoice_line_items)'\)[\s\S]{0,500}\.(insert|update|upsert|delete)\(/);
    expect(crmPage).toContain('<CrmInvoiceLineDialog');
    expect(crmPage).toContain('Review lines');
  });
});
