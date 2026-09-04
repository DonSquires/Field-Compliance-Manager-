import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20260904190000_recruitment_ats.sql');
const sql = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20260904190000_recruitment_ats.sql'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');

describe('governed recruitment ATS', () => {
  it('keeps candidate data separate from staff identities before hire', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.recruitment_vacancies');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.recruitment_candidates');
    expect(sql).toContain('provisioned_user_id uuid REFERENCES public.user_profiles');
    expect(sql).toContain('provisioned_staff_id uuid REFERENCES public.staff_profiles');
  });

  it('uses governed, idempotent vacancy and candidate creation', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_recruitment_vacancy');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.create_recruitment_candidate');
    expect(sql).toContain('UNIQUE(organization_id, client_request_id)');
    expect(sql).toContain("v_vacancy.status<>'open'");
  });

  it('requires notes and expected-state locking for candidate progression', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_recruitment_candidate');
    expect(sql).toContain('Candidate changed from expected stage % to %');
    expect(sql).toContain('A stage note is required');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.recruitment_candidate_events');
  });

  it('converts only accepted offers through existing user and staff records', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.convert_recruitment_candidate_to_staff');
    expect(sql).toContain("v_candidate.stage<>'offer' or v_candidate.status<>'offered'");
    expect(sql).toContain('Provisioned user and staff records must belong to the recruiting organization');
    expect(sql).toContain('staff_onboarding_ledgers');
  });

  it('surfaces vacancy, candidate intake, and the guarded candidate workflow', () => {
    expect(page).toContain("{ id: 'recruitment', label: 'Recruitment' }");
    expect(page).toContain('manage_recruitment_vacancy');
    expect(page).toContain('create_recruitment_candidate');
    expect(page).toContain('manage_recruitment_candidate');
    expect(page).toContain('p_offer_employment_type');
    expect(page).toContain("functions.invoke('create-user'");
    expect(page).toContain('convert_recruitment_candidate_to_staff');
    expect(page).toContain('Candidate has accepted this offer');
  });
});
