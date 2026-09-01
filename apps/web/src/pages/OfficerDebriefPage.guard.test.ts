import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerDebriefPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const completionFix = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901018000_fix_officer_shift_completion.sql'), 'utf8');

describe('officer debrief workspace', () => {
  it('replaces the exposed placeholder with a real handover page', () => {
    expect(shell).toContain('return <OfficerDebriefPage onNavigate=');
    expect(shell).not.toContain('return <ComingSoonPage title="Debrief" />');
  });
  it('uses the governed RPC with stable retry identity and structured flags', () => {
    expect(page).toContain("supabase.rpc('submit_shift_debrief'");
    expect(page).toContain('p_client_event_id: eventIdRef.current');
    expect(page).toContain('p_safety_incident_reported: safetyIncident');
    expect(page).toContain('p_equipment_issue_reported: equipmentIssue');
  });
  it('requires follow-up context and completes the shift through a separate governed action', () => {
    expect(page).toContain('!followUp || followUpNotes.trim()');
    expect(page).toContain("supabase.rpc('complete_officer_shift'");
    expect(page).toContain('p_expected_status: completionShift.status');
    expect(page).toContain('Complete shift');
    expect(page).toContain('Open timesheet');
    expect(page).toContain('Return home');
    expect(page).toContain('Recent debriefs');
    expect(completionFix).toContain("update public.roster_slots set status='completed' where linked_shift_id=v_shift.id");
    expect(completionFix).not.toMatch(/update public\.roster_slots set[^;]*updated_at/);
    expect(completionFix).toContain("v_shift.status<>p_expected_status");
  });
  it('shows and focuses admin follow-up only for the officer own debrief IDs',()=>{
    expect(page).toContain("from('debrief_followups')");
    expect(page).toContain("get('debrief')");
    expect(page).toContain('Admin follow-up');
    expect(page).toContain('officer-debrief-${debrief.id}');
  });
});