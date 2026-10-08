import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(resolve(process.cwd(), 'src/components/RepeatSubjectsPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');
const reports = readFileSync(resolve(process.cwd(), 'src/pages/ReportsHubPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261008040000_scope_subjects_and_report_privacy.sql'), 'utf8');

describe('repeat vehicle subjects', () => {
  it('reads through the summary functions, not by scanning sightings in the browser', () => {
    expect(panel).toContain("rpc('list_repeat_vehicle_subjects_for_agreement'");
    expect(panel).toContain("rpc('list_vehicle_subject_history_for_agreement'");
    expect(panel).toContain('p_service_agreement_id: agreementId');
    expect(panel).toContain("rpc('list_unlinked_plate_mentions_for_agreement'");
    expect(panel).not.toContain("from('observations')");
    expect(reports).toContain('<RepeatSubjectsPanel />');
  });

  it('exposes plates and counts only, never an owner or person name', () => {
    expect(migration).toContain('owner_identified boolean');
    expect(migration).not.toMatch(/returns table[\s\S]{0,900}registered_owner_name text/i);
    expect(panel).not.toContain('registered_owner_name');
    expect(panel).toContain("rpc('can_manage_r_and_m_identity'");
    expect(panel).toContain("rpc('list_vehicle_subject_identifications'");
    expect(migration).toContain('private.rnm_admin_for_organization(v_provider)');
    expect(panel).toContain('Identified by R&M');
  });

  it('counts only CCTV detections a person has accepted and ignores future-dated rows', () => {
    expect(migration).toContain("c.review_state = 'accepted'");
    expect(migration).toContain('<= now()');
  });

  it('checks organisation access once per organisation and is closed to anonymous callers', () => {
    expect(migration).toContain("DROP FUNCTION IF EXISTS public.list_repeat_vehicle_subjects(");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.list_repeat_vehicle_subjects_for_agreement[^;]*FROM PUBLIC, anon/);
    expect(migration).toContain('Authentication required');
  });

  it('keeps unlinked comment mentions separate from confirmed sightings', () => {
    expect(panel).toContain('Plate mentions to review');
    expect(panel).toContain('They are suggestions only and have not been counted as sightings.');
    expect(migration).toContain('list_unlinked_plate_mentions_for_agreement');
  });
});
