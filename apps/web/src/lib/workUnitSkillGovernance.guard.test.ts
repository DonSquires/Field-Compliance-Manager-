import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015025954_govern_roster_work_unit_skills.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterTargetsPage.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/RosterTargetsPage.css'), 'utf8');

describe('governed work-unit skill requirements', () => {
  it('retires free-text requirements and accepts only active organization catalog IDs', () => {
    expect(migration).toContain('DROP FUNCTION public.manage_roster_work_unit_skill_requirements(uuid, text[])');
    expect(migration).toContain('DROP FUNCTION public.manage_roster_work_unit_skill_ids(uuid, uuid[])');
    expect(migration).toContain('rsc.organization_id = v_unit.organization_id');
    expect(migration).toContain('AND rsc.active');
    expect(migration).toContain('cardinality(v_skill_ids) <> cardinality(v_requested_ids)');
    expect(migration).toContain('One or more selected skills are inactive or outside this organisation');
  });

  it('serializes retries, rejects stale edits, and records immutable before and after evidence', () => {
    expect(migration).toContain('idx_audit_roster_work_unit_skill_request');
    expect(migration).toContain("hashtextextended('roster-work-unit-skills:' || p_client_request_id::text, 0)");
    expect(migration).toContain('v_unit.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(migration).toContain("'previous_skill_ids', v_previous_ids");
    expect(migration).toContain("'resulting_skill_ids', v_unit.required_skill_ids");
    expect(migration).toContain("'record', to_jsonb(v_unit)");
  });

  it('provides catalog selection, correction, receipts, and a governed empty-state destination', () => {
    expect(page).toContain("from('roster_skill_catalog')");
    expect(page).toContain("supabase.rpc('manage_roster_work_unit_skill_ids'");
    expect(page).toContain('Configure required skills for');
    expect(page).toContain('Keep current requirements');
    expect(page).toContain('Required skills updated with an audit receipt.');
    expect(page).toContain("navigate('/admin/people-hr')");
    expect(page).not.toContain('Required skills (comma-separated)');
    expect(page).not.toContain("supabase.rpc('manage_roster_work_unit_skill_requirements'");
  });

  it('keeps the preparation workflow usable on narrow screens', () => {
    expect(css).toContain('.targets-unit-actions');
    expect(css).toContain('.targets-skill-picker');
    expect(css).toMatch(/@media \(max-width: 650px\)[\s\S]*\.targets-page \.targets-unit-actions[\s\S]*grid-template-columns: 1fr/);
  });
});
