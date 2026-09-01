import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/DebriefFollowupPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901011000_debrief_followup_ownership.sql'), 'utf8');

describe('flagged debrief follow-up ownership', () => {
  it('routes admins to a dedicated governed follow-up queue', () => {
    expect(shell).toContain('return <DebriefFollowupPage />');
    expect(page).toContain("from('debrief_followups')");
    expect(page).toContain("rpc('manage_debrief_followup'");
    expect(page).toContain('Claim follow-up');
    expect(page).toContain('Resolve follow-up');
    expect(page).not.toMatch(/from\('shift_debriefs'\)[\s\S]{0,250}\.(update|delete)\(/);
  });

  it('seeds flagged debriefs and governs versioned ownership', () => {
    for (const value of ['after insert on public.shift_debriefs', 'safety_incident_reported', 'equipment_issue_reported', 'follow_up_required', 'p_expected_version', 'for update', "'debrief_followup_managed'"]) expect(sql).toContain(value);
    expect(sql).toContain('revoke insert,update,delete on table public.debrief_followups from authenticated');
    expect(sql).toContain('from public,anon;');
  });
});