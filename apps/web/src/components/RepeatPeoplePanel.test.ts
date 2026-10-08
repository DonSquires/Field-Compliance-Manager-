import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(resolve(process.cwd(), 'src/components/RepeatPeoplePanel.tsx'), 'utf8').replace(/\r\n/g, '\n');
const searchPage = readFileSync(resolve(process.cwd(), 'src/pages/ObservationSearchPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261008040000_scope_subjects_and_report_privacy.sql'), 'utf8');

describe('agreement-scoped person observations', () => {
  it('filters repeat people and history by the selected agreement', () => {
    expect(panel).toContain("rpc('list_repeat_person_subjects_for_agreement'");
    expect(panel).toContain("rpc('list_person_subject_history_for_agreement'");
    expect(panel).toContain('p_service_agreement_id: agreementId');
    expect(panel).toContain('p_canonical_person_id: row.canonical_person_id');
    expect(migration).toContain("c.entity_kind='person' AND c.review_state='accepted'");
    expect(migration).toContain("cp.review_state='verified' AND cp.status='active'");
  });

  it('opens a scoped history dialog with evidence for the selected canonical person', () => {
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain('RecordEvidencePanel');
    expect(panel).toContain('CctvEvidenceLink');
    expect(panel).toContain('p_canonical_person_id: row.canonical_person_id');
    expect(searchPage).toContain("searchParams.get('person') ?? ''");
    expect(searchPage).toContain('p_person_id: personId || null');
  });

  it('keeps person lists and history behind the R&M administrator check', () => {
    expect(migration).toContain("NOT private.rnm_admin_for_organization(v_provider)");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.list_repeat_person_subjects_for_agreement[^;]*FROM PUBLIC, anon/);
    expect(migration).toContain("pr.review_state='verified'");
  });
});
