import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20260904200000_hr_performance_cases.sql');
const sql = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20260904200000_hr_performance_cases.sql'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');

describe('private HR performance and case management', () => {
  it('keeps private employee cases separate from field incidents', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.hr_cases');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.hr_case_events');
    expect(sql).not.toContain('INSERT INTO public.incidents');
    expect(sql).toContain('hr_cases_admin_select');
  });
  it('uses audited, governed performance and case lifecycle actions', () => {
    expect(sql).toContain('manage_performance_review_cycle');
    expect(sql).toContain('create_performance_review');
    expect(sql).toContain('complete_performance_review');
    expect(sql).toContain('manage_hr_case');
    expect(sql).toContain("'performance_review_completed'");
    expect(sql).toContain("'hr_case_managed'");
  });
  it('surfaces separate performance and HR case views', () => {
    expect(page).toContain("{ id: 'performance', label: 'Performance' }");
    expect(page).toContain("{ id: 'cases', label: 'HR Cases' }");
    expect(page).toContain('manage_performance_review_cycle');
    expect(page).toContain('create_performance_review');
    expect(page).toContain('complete_performance_review');
    expect(page).toContain('manage_hr_case');
    expect(page).toContain("action: 'review'");
    expect(page).toContain("action: 'note'");
    expect(page).toContain("action: 'resolve'");
    expect(page).toContain("action: 'withdraw'");
  });
});
