import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/BreachReviewPage.tsx'), 'utf8');
const officer = readFileSync(resolve(process.cwd(), 'src/pages/OfficerFreedomCampingPage.tsx'), 'utf8');
const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901010000_govern_breach_outcomes.sql'), 'utf8');

describe('governed breach outcome return', () => {
  it('routes every admin lifecycle action through one expected-state RPC', () => {
    expect(page).toContain("rpc('manage_breach_alert'");
    expect(page).toContain('p_expected_status: alert.status');
    expect(page).not.toMatch(/from\('breach_alerts'\)[\s\S]{0,300}\.update\(/);
  });

  it('generates supported notice drafts through the authenticated edge function', () => {
    expect(page).toContain("operation: 'preview'");
    expect(page).toContain("operation: 'authorize_print'");
    expect(page).toContain('typed_name: typedAuthorizerNames[alert.id]');
    expect(page).toContain('print_request_id: printRequestIds[alert.id]');
    expect(page).toContain('Authorize Print');
    expect(page).toContain('breach_alert_id: alert.id');
    expect(page).toContain("['written_warning', 'notice_to_vacate', 'infringement']");
    expect(page).toContain('noticeArtifactPaths');
    expect(page).toContain('GeneratedArtifactActions bucket="notice-artifacts"');
    expect(page).not.toMatch(/from\('(notices_to_vacate|infringement_notices)'\)/);
  });

  it('does not invent cross-status filter counts from a single-status query', () => {
    expect(page).toContain("if (statusFilter !== 'all')");
    expect(page).not.toContain('alerts.filter(a => a.status ===');
  });

  it('shows exact officer-owned breach outcomes', () => {
    expect(officer).toContain("from('breach_alerts')");
    expect(officer).toContain("get('breach')");
    expect(officer).toContain('Enforcement receipts');
    expect(officer).toContain('officer-breach-${breach.id}');
  });

  it('makes acknowledged officer requests explicitly approvable or dismissible', () => {
    expect(page).toContain("alert.status === 'acknowledged'");
    expect(page).toContain("'approve_requested'");
    expect(page).toContain('Officer request awaiting review');
    expect(page).toContain('requested_action');
    expect(page).toContain('enforcement_mode');
  });

  it('locks, audits, personally notifies attributable officers, and closes direct updates', () => {
    for (const value of ['for update', 'is_admin_for_org', 'v_alert.status<>p_expected_status', "'breach_alert_managed'", 'p_recipient_user_id=>v_officer', "'breach_alert_id',v_alert.id"]) expect(sql).toContain(value);
    expect(sql).toContain('revoke update,delete on table public.breach_alerts from authenticated');
    expect(sql).toContain('from public,anon;');
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(page).toContain('if (!orgId) {');
    expect(page).toContain("setError('Organisation access could not be confirmed. Breach review is unavailable.');");
    expect(page).toContain('setLoading(false);');
  });
});