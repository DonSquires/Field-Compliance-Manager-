import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const submissionSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830125000_submit_officer_field_report.sql'), 'utf8');
const hardeningSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830142000_harden_officer_field_report_submission.sql'), 'utf8');

describe('governed officer field report submission', () => {
  it('binds report ownership to the authenticated active officer', () => {
    expect(submissionSql).toContain("p.id = v_user_id and p.deactivated_at is null and p.role in ('officer', 'admin_officer')");
    expect(submissionSql).toContain('s.officer_user_id = v_user_id');
  });

  it('is retry-safe and returns an auditable server receipt', () => {
    expect(submissionSql).toContain('idx_officer_field_reports_client_event');
    expect(submissionSql).toContain('return query select v_existing.id, false');
    expect(submissionSql).toContain("'officer_field_report_submitted'");
  });

  it('closes every direct authenticated mutation path', () => {
    expect(hardeningSql).toContain('drop policy if exists officer_insert_field_reports');
    expect(hardeningSql).toContain('drop policy if exists officer_update_field_reports');
    expect(hardeningSql).toContain('revoke insert, update, delete, truncate on public.officer_field_reports from public, anon, authenticated');
  });
});