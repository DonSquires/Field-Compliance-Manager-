import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/WelfareAlertsPage.tsx'), 'utf8');
const outcomeSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901005000_welfare_outcome_return.sql'), 'utf8');

describe('supervisor welfare response workbench', () => {
  it('fails closed for welfare reads, subscriptions, and response controls until entitlement is confirmed', () => {
    expect(source).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(source).toContain('<SafetyGate');
    expect(source).toContain('!profile?.organizationId || !welfareEnabled');
    expect(source).toContain('if (!profile?.organizationId || !welfareEnabled) return;');
  });

  it('loads tenant-scoped alerts and subscribes with the same tenant filter', () => {
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain('filter: `organization_id=eq.${profile.organizationId}`');
  });

  it('records distinct acknowledgement and resolution evidence', () => {
    expect(source).toContain("supabase.rpc('manage_welfare_alert'");
    expect(source).toContain('p_expected_status: selected.status');
    expect(source).toContain('p_notes: actionNotes.trim()');
    expect(source).not.toContain(".from('welfare_alerts').update");
  });

  it('avoids RLS-sensitive profile expansions while preserving actor identity IDs', () => {
    expect(source).toContain('acknowledged_by, acknowledged_at');
    expect(source).toContain('resolved_by, resolved_at');
    expect(source).toContain('formatActor(selected.acknowledged_by,');
    expect(source).toContain('formatActor(selected.resolved_by,');
    expect(source).not.toContain('officer:officer_user_id(');
    expect(source).not.toContain('acknowledger:acknowledged_by(');
    expect(source).not.toContain('resolver:resolved_by(');
  });

  it('requires human notes and surfaces concurrent transition failures', () => {
    expect(source).toContain('required rows={4}');
    expect(source).toContain('This alert changed before your action was saved');
  });

  it('provides a recovery action when alert loading fails', () => {
    expect(source).toContain('className="welfare-retry"');
    expect(source).toContain('onClick={() => void loadAlerts()}');
  });

  it('uses real phone and GPS actions rather than inert controls', () => {
    expect(source).toContain('href={`tel:');
    expect(source).toContain('https://www.google.com/maps?q=');
  });

  it('returns acknowledgement and resolution outcomes personally to the officer', () => {
    expect(outcomeSql).toContain('p_recipient_user_id=>v_alert.officer_user_id');
    expect(outcomeSql).toContain("'welfare_alert_id',v_alert.id");
    expect(outcomeSql).toContain("'welfare_alert_outcome:'||v_alert.id::text||':'||v_alert.status");
  });
});