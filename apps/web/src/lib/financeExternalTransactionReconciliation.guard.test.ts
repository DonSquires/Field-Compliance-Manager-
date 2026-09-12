import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912141000_finance_external_transaction_reconciliation.sql'), 'utf8');
const dashboard = readFileSync(resolve(process.cwd(), 'src/components/FinanceOperationsDashboard.tsx'), 'utf8');

describe('external finance transaction reconciliation', () => {
  it('matches bank activity to payment receipts with amount and tenant checks', () => {
    expect(migration).toContain('match_finance_external_bank_transaction');
    expect(migration).toContain('Transaction amount does not match payment receipt');
    expect(migration).toContain("reconciliation_status = 'matched'");
    expect(migration).toContain('finance_external_transaction_matched');
  });

  it('surfaces external bank activity in the owner money check', () => {
    expect(dashboard).toContain("from('finance_external_bank_transactions')");
    expect(dashboard).toContain('unmatchedTransactions');
    expect(dashboard).toContain('bank activity needing a match');
  });
});
