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

  it('shows exact officer-owned breach outcomes', () => {
    expect(officer).toContain("from('breach_alerts')");
    expect(officer).toContain("get('breach')");
    expect(officer).toContain('Admin outcome');
    expect(officer).toContain('officer-breach-${breach.id}');
  });

  it('locks, audits, personally notifies attributable officers, and closes direct updates', () => {
    for (const value of ['for update', 'is_admin_for_org', 'v_alert.status<>p_expected_status', "'breach_alert_managed'", 'p_recipient_user_id=>v_officer', "'breach_alert_id',v_alert.id"]) expect(sql).toContain(value);
    expect(sql).toContain('revoke update,delete on table public.breach_alerts from authenticated');
    expect(sql).toContain('from public,anon;');
  });

  it('actually generates the printable notice document for notice-producing enforcement decisions', () => {
    // generate-notice already existed (atomic notice numbering, template
    // rendering, infringement_notices/notices_to_vacate inserts) but no page
    // ever called it -- the "Issue Infringement"/"Notice to Vacate"/"Written
    // Warning" actions only ever marked the breach_alerts row, with no
    // document produced.
    expect(page).toContain("functions.invoke<{ ok: boolean; notice_id: string; pdf_url: string | null }>('generate-notice'");
    expect(page).toContain('NOTICE_GENERATING_ACTIONS');
    expect(page).toContain("written_warning: 'written_warning'");
    expect(page).toContain("notice_to_vacate: 'notice_to_vacate'");
    expect(page).toContain("infringement: 'infringement'");
    expect(page).toContain('View generated notice');
  });
});