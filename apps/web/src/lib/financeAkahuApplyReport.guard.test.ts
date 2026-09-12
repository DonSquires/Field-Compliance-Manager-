import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912147000_akahu_apply_report_ledger.sql'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-report/index.ts'), 'utf8');

describe('Akahu Apply report staging', () => {
  it('keeps reports tenant-scoped and reviewable', () => {
    expect(migration).toContain('finance_akahu_apply_reports');
    expect(migration).toContain('REFERENCES public.finance_akahu_apply_applications(id)');
    expect(migration).toContain('failure_reason jsonb');
    expect(migration).toContain('result_summary jsonb');
    expect(edge).toContain(".eq('organization_id', profile.organization_id)");
  });

  it('creates and polls reports without automatically posting finance data', () => {
    expect(edge).toContain('/reports');
    expect(edge).toContain('/reports/${reportId}');
    expect(edge).toContain('document_ids');
    expect(edge).toContain('finance_akahu_apply_report_created');
    expect(edge).toContain('finance_akahu_apply_report_status_checked');
    expect(edge).toContain('finance_akahu_apply_report_reviewed');
    expect(edge).toContain('transactions.slice(0, 50)');
    expect(edge).not.toContain('record_akahu_import');
    expect(edge).not.toContain('payment_receipt');
  });
});
