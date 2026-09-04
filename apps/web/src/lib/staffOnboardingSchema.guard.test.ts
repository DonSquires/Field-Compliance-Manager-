import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => {
  const local = resolve(process.cwd(), `supabase/migrations/${name}`);
  return readFileSync(existsSync(local) ? local : resolve(process.cwd(), `../../supabase/migrations/${name}`), 'utf8');
};
const ledger = migration('20260904170000_staff_onboarding_ledger.sql');
const evidence = migration('20260904180000_staff_onboarding_evidence.sql');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');

describe('governed staff onboarding', () => {
  it('keeps staff onboarding separate from client onboarding invitations', () => {
    expect(ledger).toContain('CREATE TABLE IF NOT EXISTS public.staff_onboarding_ledgers');
    expect(ledger).toContain('staff_id uuid NOT NULL UNIQUE REFERENCES public.staff_profiles');
    expect(ledger).not.toContain('INSERT INTO public.onboarding_invites');
  });

  it('starts through a retry-safe governed RPC and records immutable events', () => {
    expect(ledger).toContain('CREATE OR REPLACE FUNCTION public.start_staff_onboarding');
    expect(ledger).toContain('client_request_id is required');
    expect(ledger).toContain('CREATE TABLE IF NOT EXISTS public.staff_onboarding_events');
    expect(ledger).toContain("'staff_onboarding_started'");
  });

  it('requires each stage only after its preceding evidence is complete', () => {
    expect(ledger).toContain('Identity must be complete before employment');
    expect(ledger).toContain('Employment details must be complete before evidence');
    expect(ledger).toContain('A line manager must be assigned before induction');
    expect(ledger).toContain('Induction must be complete before review');
    expect(ledger).toContain('Staff onboarding blockers remain');
  });

  it('governs skills, reporting, induction, and documents through one HR evidence RPC', () => {
    expect(evidence).toContain('CREATE OR REPLACE FUNCTION public.manage_staff_onboarding_evidence');
    expect(evidence).toContain("p_action = 'add_skill'");
    expect(evidence).toContain("p_action = 'assign_line_manager'");
    expect(evidence).toContain("p_action = 'record_induction'");
    expect(evidence).toContain("p_action = 'record_document'");
    expect(evidence).toContain("'staff_onboarding_evidence_recorded'");
  });

  it('surfaces the canonical queue and uses the governed lifecycle RPCs', () => {
    expect(page).toContain("{ id: 'onboarding', label: 'Onboarding' }");
    expect(page).toContain("get_staff_onboarding_readiness");
    expect(page).toContain("start_staff_onboarding");
    expect(page).toContain("manage_staff_onboarding");
  });
});
