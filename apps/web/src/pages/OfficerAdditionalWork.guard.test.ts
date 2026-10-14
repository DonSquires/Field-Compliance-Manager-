import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerSchedulePage.tsx'), 'utf8');

describe('officer additional-work responses', () => {
  it('loads only the signed-in officer pending work and uses governed response RPCs', () => {
    expect(page).toContain("from('on_call_periods')");
    expect(page).toContain(".eq('officer_user_id', profile.id)");
    expect(page).toContain("from('overtime_offers')");
    expect(page).toContain("supabase.rpc('respond_to_on_call_period'");
    expect(page).toContain("supabase.rpc('respond_to_overtime_offer'");
    expect(page).not.toMatch(/from\('(on_call_periods|overtime_offers)'\)[\s\S]{0,250}\.(insert|update|upsert|delete)\(/);
  });

  it('requires confirmation and a reason for declines', () => {
    expect(page).toContain('p_expected_status: workResponse.expectedStatus');
    expect(page).toContain('Decline reason');
    expect(page).toContain('Confirm acceptance');
    expect(page).toContain('Confirm decline');
    expect(page).toContain('declined with your reason recorded');
  });
});
