import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerFieldReportPage.tsx'), 'utf8');

describe('officer field report capture UI', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(source).toContain("setError('Organisation access could not be confirmed. Field reports are unavailable.');");
    expect(source).toContain('setLoading(false);');
  });

  it('uses only the governed capture RPC for submission', () => {
    expect(source).toContain("supabase.rpc('submit_officer_field_report'");
    expect(source).not.toContain(".from('officer_field_reports').insert");
    expect(source).not.toContain(".from('incidents').insert");
    expect(source).toContain(".from('incidents')");
    expect(source).toContain(".eq('officer_user_id', profile.id)");
  });
  it('records incident identity only through governed RPCs and private evidence intake', () => {
    expect(source).toContain("supabase.rpc('record_incident_person_identity'");
    expect(source).toContain("supabase.rpc('register_incident_identity_attachment'");
    expect(source).toContain("mode: 'incident_identity_document'");
    expect(source).toContain("supabase.storage.from('identity-evidence').upload");
    expect(source).toContain('remains unverified until approval');
  });
  it('preserves retry identity and capture time until confirmed', () => {
    expect(source).toContain('p_client_event_id: eventIdRef.current');
    expect(source).toContain('p_reported_at: capturedAtRef.current');
    expect(source).toContain('Your entries remain available for retry.');
  });
  it('captures shift, optional GPS, immediate action, and required follow-up context', () => {
    expect(source).toContain('p_shift_id: form.shiftId || null');
    expect(source).toContain('p_gps_lat: gps.lat');
    expect(source).toContain('p_immediate_action: form.immediateAction.trim() || null');
    expect(source).toContain('!form.followUp || form.followUpNotes.trim().length > 0');
  });
  it('resolves typed addresses through the governed LINZ and Google proxy', () => {
    expect(source).toContain('resolveAddressCandidates(query, 1)');
    expect(source).toContain('setForm((current) => ({ ...current, address: candidate.label }))');
  });
  it('opens the exact report and shows the supervisor review outcome', () => {
    expect(source).toContain("new URLSearchParams(location.search).get('report')");
    expect(source).toContain('review_notes, reviewed_at');
    expect(source).toContain('Supervisor review');
    expect(source).toContain('is-context-focus');
  });
});
