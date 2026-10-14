import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261014190239_harden_finance_payment_matching.sql'),
  'utf8',
);
const creditMigration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261014190902_enforce_finance_statement_credit_matching.sql'),
  'utf8',
);
const liveSchema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const workspace = readFileSync(resolve(process.cwd(), 'src/components/FinanceReconciliationWorkspace.tsx'), 'utf8');
const moneyPage = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');

describe('finance payment matching authority', () => {
  it('serializes one receipt across statement and connected-bank sources', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended('finance-payment-match:'");
    expect(migration).toContain('finance_statement_lines_one_payment_match');
    expect(migration).toContain('finance_external_transactions_one_payment_match');
    expect(migration).toContain('Payment receipt is already matched to another bank movement');
  });

  it('keeps retries idempotent and rejects stale or disputed state', () => {
    expect(migration).toContain("v_line.reconciliation_status = 'matched'");
    expect(migration).toContain("v_transaction.reconciliation_status = 'matched'");
    expect(migration).toContain("v_payment.reconciliation_status NOT IN ('pending', 'unmatched')");
    expect(migration).toContain("v_receipt.reconciliation_status NOT IN ('pending', 'unmatched')");
    expect(migration).toContain("v_transaction.direction <> 'credit'");
    expect(creditMigration).toContain("v_line.transaction_type <> 'credit'");
  });

  it('keeps both security-definer endpoints off public and anonymous roles', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.match_finance_bank_statement_line(uuid, uuid)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.match_finance_external_bank_transaction(uuid, uuid)');
    expect(migration).toContain('TO authenticated, service_role');
  });

  it('is present in the regenerated live schema', () => {
    expect(liveSchema).toContain('finance_statement_lines_one_payment_match');
    expect(liveSchema).toContain('finance_external_transactions_one_payment_match');
    expect(liveSchema).toContain("pg_advisory_xact_lock(hashtextextended('finance-payment-match:'");
    expect(liveSchema).toContain("v_line.transaction_type <> 'credit'");
    expect(liveSchema).toContain('Payment receipt is already matched to another bank movement');
    expect(liveSchema).toMatch(/REVOKE ALL ON FUNCTION "public"\."match_finance_bank_statement_line".*FROM PUBLIC, "anon"/);
    expect(liveSchema).toMatch(/REVOKE ALL ON FUNCTION "public"\."match_finance_external_bank_transaction".*FROM PUBLIC, "anon"/);
  });
});

describe('finance payment matching workspace', () => {
  it('loads tenant-scoped movements and unmatched receipts', () => {
    for (const table of ['finance_external_bank_transactions', 'finance_bank_statement_lines', 'payment_receipts']) {
      expect(workspace).toContain(`from('${table}')`);
      expect(workspace).toContain(".eq('organization_id', profile.organizationId)");
    }
    expect(workspace).toContain(".in('reconciliation_status', ['pending', 'unmatched'])");
  });

  it('offers exact incoming-credit candidates through the governed RPCs', () => {
    expect(workspace).toContain("transaction.direction === 'credit'");
    expect(workspace).toContain("line.transaction_type === 'credit'");
    expect(workspace).toContain('Math.abs(Number(receipt.payment_amount) - selected.amount) <= 0.01');
    expect(workspace).toContain("supabase.rpc('match_finance_external_bank_transaction'");
    expect(workspace).toContain("supabase.rpc('match_finance_bank_statement_line'");
  });

  it('never writes reconciliation tables directly and is mounted in the money workflow', () => {
    expect(workspace).not.toMatch(/from\('(finance_external_bank_transactions|finance_bank_statement_lines|payment_receipts)'\)[\s\S]{0,500}\.(insert|update|upsert|delete)\(/);
    expect(moneyPage).toContain("import { FinanceReconciliationWorkspace } from '../components/FinanceReconciliationWorkspace';");
    expect(moneyPage).toContain('<FinanceReconciliationWorkspace />');
  });
});
