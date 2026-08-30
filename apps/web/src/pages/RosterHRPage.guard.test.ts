import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');

describe('governed HR administration', () => {
  it('uses server-owned leave and timesheet decisions', () => {
    expect(page).toContain("supabase.rpc('review_leave_request'");
    expect(page).toContain("supabase.rpc('review_timesheet'");
    expect(page).not.toContain(".from('leave_requests').update");
    expect(page).not.toContain(".from('timesheets').update");
  });

  it('uses governed coverage creation and reasoned review', () => {
    expect(page).toContain("supabase.rpc('create_shift_coverage_request'");
    expect(page).not.toContain(".from('shift_coverage_requests').insert");
    expect(page).toContain('Review notes');
    expect(page).toContain('p_expected_status: currentStatus');
  });

  it('loads derived readiness and changes it only through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('get_staff_readiness_assessment'");
    expect(page).toContain("supabase.rpc('set_staff_work_readiness'");
    expect(page).toContain('Readiness review notes');
    expect(page).not.toContain(".from('staff_profiles').update");
  });
});