import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerNoiseControlPage.tsx'), 'utf8');

describe('officer noise control — two-place job flow', () => {
  it('shows both places of a complaint job with their roles and the confidentiality rule', () => {
    expect(page).toContain('Noise source · work place');
    expect(page).toContain('Complainant place · protected');
    expect(page).toContain('Assessment, direction and seizure are recorded against this address.');
    expect(page).toContain('Never on a served document.');
    expect(page).toContain("'module_key.eq.noise_control,job_type.eq.noise_control'");
  });

  it('records attendance at each place only through the governed arrival and departure commands', () => {
    expect(page).toContain("rpc('arrive_at_dispatch_place'");
    expect(page).toContain("rpc('depart_dispatch_place'");
    expect(page).toContain("arriveAt('work_place')");
    expect(page).toContain("arriveAt('harmed_party_place')");
    expect(page).toContain('p_bwc_reference');
    expect(page).not.toMatch(/from\('shift_stops'\)[\s\S]{0,200}\.(insert|update|upsert)\(/);
    expect(page).not.toMatch(/from\('dispatch_jobs'\)[\s\S]{0,200}\.(insert|update|upsert)\(/);
  });

  it('shows the geofence verification loudly and never blocks on it', () => {
    for (const outcome of ['verified_on_site', 'near_site', 'off_site', 'unverified_boundary', 'no_geofence', 'no_gps']) expect(page).toContain(`${outcome}:`);
    expect(page).toContain('attendance will be recorded by time only and the report will say so');
    expect(page).not.toMatch(/disabled=\{[^}]*arrivalGps\.status === 'unavailable'/);
  });

  it('requires a delay reason when the response SLA was breached', () => {
    expect(page).toContain('Delay reason (SLA breached — the client report must state it)');
    expect(page).toContain('p_sla_delay_reason: delayReason.trim() || null');
  });

  it('submits the assessment with the job so both places derive server-side, and states the position rule', () => {
    expect(page).toContain("rpc('submit_officer_noise_assessment'");
    expect(page).toContain('p_dispatch_job_id: selectedJob?.id ?? null');
    expect(page).not.toContain('p_complainant_site_id');
    expect(page).not.toContain('p_complaint_address');
    expect(page).toContain('the report states the distance, never the complainant');
    expect(page).toContain('Public position as near the complainant as possible');
  });

  it('enforces the statutory preconditions in the form before the server does', () => {
    expect(page).toContain("const endWithoutComplaint = form.action_taken === 'direction_notice' && !selectedJob;");
    expect(page).toContain("const seizureWithoutPolice = form.action_taken === 'equipment_seized' && !form.police_present;");
    expect(page).toContain('&& !statutoryNumberMissing && !endWithoutComplaint && !seizureWithoutPolice');
    expect(page).toContain("disabled={action === 'direction_notice' && !selectedJob}");
    expect(page).toContain('Police present (required for seizure — RMA s328(3))');
    expect(page).toContain('statutory maximum 8 days');
    expect(page).not.toMatch(/72\s?h/);
  });

  it('reads complainant identity only through the audited RPC and does not persist it', () => {
    expect(page).toContain("rpc('get_dispatch_job_protected_party'");
    expect(page).toContain('Reveal complainant contact — this read is logged');
    expect(page).toContain('Never repeat this to the noise source.');
    expect(page).not.toContain("from('dispatch_job_protected_parties')");
    expect(page).toContain('setRevealedContact(null)');
    expect(page).not.toMatch(/localStorage|sessionStorage/);
  });

  it('records complainant contact as a linked interaction, arriving at the complainant place first when in person', () => {
    expect(page).toContain("rpc('record_job_party_interaction'");
    expect(page).toContain("p_party_role: 'complainant'");
    expect(page).toContain('p_noise_assessment_id: jobAssessments[0]?.id ?? null');
    expect(page).toContain("(contact.mode === 'in_person' && !complainantStop?.actual_arrived_at)");
    expect(page).toContain('What was said (no names)');
    expect(page).not.toMatch(/from\('job_party_interactions'\)[\s\S]{0,200}\.(insert|update|upsert)\(/);
  });

  it('surfaces the pre-arrival dossier for the source address from live rows', () => {
    expect(page).toContain('Pre-arrival dossier · source address');
    expect(page).toContain('END in force until');
    expect(page).toContain('Permanent abatement on record');
    expect(page).toContain('H&amp;S flag — read notes before approaching');
    expect(page).toMatch(/from\('noise_assessments'\)[\s\S]{0,400}\.eq\('site_id', job\.client_site_id\)/);
  });

  it('keeps the officer-scoped states truthful', () => {
    expect(page).toContain("if (!profile?.id || !profile?.organizationId) {");
    expect(page).toContain("setError('Organisation access could not be confirmed. Noise assessments are unavailable.');");
    expect(page).toContain('No open noise complaint jobs are assigned to you.');
    expect(page).toContain('an excessive noise direction needs a received complaint (RMA s327)');
  });

  it('records how a direction was given only through the governed command, with the statutory rules mirrored in the form', () => {
    expect(page).toContain("rpc('record_noise_direction_particulars'");
    expect(page).toContain('p_given_orally: particulars.givenOrally');
    expect(page).toContain('p_recipient_role: particulars.recipientRole');
    expect(page).toContain('p_period_hours: particularsPeriod');
    expect(page).toContain('p_entry_notice_left: particulars.entryNoticeLeft || null');
    expect(page).not.toMatch(/from\('noise_assessments'\)[\s\S]{0,200}\.(insert|update|upsert)\(/);
    // s327(3): 8 days or a shorter officer-specified period, never beyond the council rule.
    expect(page).toContain('const STATUTORY_END_HOURS = 192;');
    expect(page).toContain("from('noise_module_config')");
    expect(page).toContain('hours >= 1 && hours <= STATUTORY_END_HOURS ? hours : STATUTORY_END_HOURS');
    expect(page).toContain('particularsPeriod < 1 || particularsPeriod > endCapHours');
    // s328(5): an unoccupied entry leaves the written direction and an entry notice.
    expect(page).toContain("const unoccupiedWithoutNotice = particulars.recipientRole === 'unoccupied_notice_left' && !particulars.entryNoticeLeft;");
    expect(page).toContain("const unoccupiedOral = particulars.recipientRole === 'unoccupied_notice_left' && particulars.givenOrally;");
    expect(page).toContain('&& !particularsPeriodInvalid && !unoccupiedWithoutNotice && !unoccupiedOral');
    expect(page).toContain('Written direction and entry notice left in a prominent position (required — RMA s328(5))');
    expect(page).toContain('Now record how it was given.');
    expect(page).toContain('Record how the direction was given');
  });
});
