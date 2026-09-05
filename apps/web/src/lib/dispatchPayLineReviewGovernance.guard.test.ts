import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905000000_govern_dispatch_pay_line_reviews.sql'),
  'utf8',
);

describe('dispatch pay-line review governance', () => {
  it('stores decisions in an append-only, org-scoped review ledger', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.dispatch_job_pay_line_reviews');
    expect(migration).toContain('supersedes_review_id uuid REFERENCES public.dispatch_job_pay_line_reviews');
    expect(migration).toContain('UNIQUE (organization_id, client_request_id)');
    expect(migration).toContain("CHECK (decision <> 'rejected' OR nullif(trim(review_notes), '') IS NOT NULL)");
    expect(migration).toContain('REVOKE ALL ON TABLE public.dispatch_job_pay_line_reviews FROM PUBLIC, anon, authenticated');
  });

  it('reviews only through an admin-authorized, retry-safe, race-checked RPC', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.review_dispatch_job_pay_line');
    expect(migration).toContain("if not public.is_admin_for_org(v_line.organization_id) then");
    expect(migration).toContain('where organization_id = (select organization_id from public.dispatch_job_pay_lines where id = p_pay_line_id)');
    expect(migration).toContain('for update;');
    expect(migration).toContain('if v_current_review_id is distinct from p_expected_review_id then');
    expect(migration).toContain("'dispatch_pay_line_reviewed'");
  });

  it('blocks timesheet approval and payroll export on unresolved, unreviewed, or rejected dispatch pay evidence', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.timesheet_dispatch_pay_review_blocker');
    expect(migration).toContain("'missing pay evidence for dispatch work'");
    expect(migration).toContain("'unresolved dispatch pay evidence'");
    expect(migration).toContain("'unreviewed dispatch pay evidence'");
    expect(migration).toContain("'rejected dispatch pay evidence'");
    expect(migration).toContain("raise exception 'Timesheet cannot be approved: %', v_pay_blocker;");
    expect(migration).toContain("raise exception 'Payroll export blocked by timesheet %: %', v_blocked_timesheet, v_pay_blocker;");
  });

  it('does not alter calculated pay lines or manufacture financial amounts', () => {
    expect(migration).not.toMatch(/update\s+public\.dispatch_job_pay_lines\b/i);
    expect(migration).not.toMatch(/delete\s+from\s+public\.dispatch_job_pay_lines\b/i);
    expect(migration).not.toMatch(/insert\s+into\s+public\.dispatch_job_pay_lines\b/i);
  });
});
