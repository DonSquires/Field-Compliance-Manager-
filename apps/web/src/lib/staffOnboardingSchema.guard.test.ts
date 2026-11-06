import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => {
  const local = resolve(process.cwd(), `supabase/migrations/${name}`);
  return readFileSync(existsSync(local) ? local : resolve(process.cwd(), `../../supabase/migrations/${name}`), 'utf8');
};
const ledger = migration('20260904170000_staff_onboarding_ledger.sql');
const evidence = migration('20260904180000_staff_onboarding_evidence.sql');
const documentHardening = migration('20261107130000_staff_document_legacy_path_hardening.sql');
const employment = migration('20261018075927_govern_staff_employment_setup.sql');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');
const profilePage = readFileSync(resolve(process.cwd(), 'src/pages/StaffProfilePage.tsx'), 'utf8');

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

  it('governs onboarding evidence and routes document uploads through the private profile flow', () => {
    expect(evidence).toContain('CREATE OR REPLACE FUNCTION public.manage_staff_onboarding_evidence');
    expect(evidence).toContain("p_action = 'add_skill'");
    expect(evidence).toContain("p_action = 'assign_line_manager'");
    expect(evidence).toContain("p_action = 'record_induction'");
    expect(evidence).toContain("'staff_onboarding_evidence_recorded'");
    expect(documentHardening).toContain("RAISE EXCEPTION 'Staff documents must be uploaded through record_staff_document_upload'");
    expect(documentHardening).toContain("(storage.foldername(storage.objects.name))[1] = document.organization_id::text");
    expect(documentHardening).toContain("(storage.foldername(storage.objects.name))[3] = document.staff_id::text");
  });

  it('surfaces the canonical queue and uses the governed lifecycle RPCs', () => {
    expect(page).not.toContain("{ id: 'onboarding', label: 'Onboarding' }");
    expect(profilePage).toContain("get_staff_onboarding_readiness");
    expect(profilePage).toContain("start_staff_onboarding");
    expect(profilePage).toContain("manage_staff_onboarding");
    expect(profilePage).toContain("manage_staff_onboarding_evidence");
    expect(page).toContain("ledger.next_action === 'Upload evidence') openStaffProfile(person, 'onboarding')");
  });

  it('treats employment setup as one governed, race-checked onboarding action', () => {
    expect(employment).toContain('CREATE OR REPLACE FUNCTION public.set_staff_employment_setup');
    expect(employment).toContain('Staff employment changed; reload before saving');
    expect(employment).toContain('An active organization payroll role is required');
    expect(employment).toContain("'staff_employment_setup_saved'");
    expect(employment).toContain("sp.employment_type IS NULL OR sp.start_date IS NULL");
    expect(employment).toContain("sp.role_code IS NULL THEN 'Assign a payroll role'");
    expect(employment).toContain("THEN 'Complete employment setup'");
    expect(page).toContain("supabase.rpc('set_staff_employment_setup'");
    expect(page).toContain('onClick={() => runOnboardingPrimaryAction(person, ledger, name)}>{onboardingPrimaryActionLabel(ledger)}</button>');
    expect(page).toContain("onClick={() => openStaffProfile(person, 'onboarding')}>Open profile");
  });
});
