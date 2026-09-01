import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/FieldReportsPage.tsx'), 'utf8');
const outcomeSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901003000_field_report_review_outcome.sql'), 'utf8');

describe('field report review workbench', () => {
  it('uses only the governed review RPC for lifecycle transition', () => {
    expect(source).toContain("supabase.rpc('review_officer_field_report'");
    expect(source).not.toContain(".update({ status: 'reviewed'");
    expect(source).not.toContain(".from('incidents')");
  });

  it('requires review notes and sends the expected current status', () => {
    expect(source).toContain('p_expected_status: selected.status');
    expect(source).toContain('p_review_notes: reviewNotes.trim()');
    expect(source).toContain('!reviewNotes.trim()');
  });

  it('exposes searchable filters, reviewer provenance, and checked feedback', () => {
    expect(source).toContain('Search reports or officers');
    expect(source).toContain('selected.review_notes');
    expect(source).toContain('Review recorded with supervisor notes and audit provenance.');
  });

  it('returns each review outcome to the submitting officer', () => {
    expect(outcomeSql).toContain("'report_reviewed'");
    expect(outcomeSql).toContain('p_recipient_user_id=>v_report.officer_id');
    expect(outcomeSql).toContain("'report_id',v_report.id");
    expect(outcomeSql).toContain("'field-report-reviewed:'||v_report.id::text");
  });
});
