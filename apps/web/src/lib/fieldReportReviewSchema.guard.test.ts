import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830122000_review_officer_field_report.sql'), 'utf8');

describe('governed field report review', () => {
  it('locks and race-checks the submitted report before transition', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('v_report.status <> p_expected_status');
    expect(migration).toContain("v_report.status <> 'submitted'");
  });

  it('requires supervisor notes and organization admin authority', () => {
    expect(migration).toContain("nullif(trim(p_review_notes), '')");
    expect(migration).toContain('public.is_admin_for_org(v_report.organization_id)');
  });

  it('records reviewer provenance and an audit event atomically', () => {
    expect(migration).toContain('reviewed_by = v_actor_id');
    expect(migration).toContain("'officer_field_report_reviewed'");
    expect(migration).toContain("'review_notes', v_report.review_notes");
  });
});