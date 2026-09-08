import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('site brief promotion execution boundary', () => {
  it('requires approved site briefs and an explicit typed work unit target', () => {
    expect(migration).toContain('apply_site_brief_promotion_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'site_brief' OR v_proposal.status <> 'approved'");
    expect(migration).toContain("p_work_unit_type NOT IN ('patrol','static','internal')");
    expect(migration).toContain('create_roster_work_unit');
  });

  it('preserves proposal provenance and revokes direct execution access', () => {
    expect(migration).toContain('roster_work_units');
    expect(migration).toContain('document_version_id');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_site_brief_promotion_proposal');
  });
});