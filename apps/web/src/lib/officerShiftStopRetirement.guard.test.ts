import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014200635_retire_unsafe_officer_shift_stop.sql'),
  'utf8',
);
const completionAuthority = readFileSync(
  resolve(root, 'supabase/migrations/20260831098000_complete_officer_shift.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const endShiftDialog = readFileSync(
  resolve(root, 'apps/web/src/components/EndShiftDialog.tsx'),
  'utf8',
);

describe('unsafe officer shift stop retirement', () => {
  it('removes the completion path that bypassed readiness checks', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.stop_officer_shift(uuid, text);',
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."stop_officer_shift"/,
    );
    expect(databaseTypes).not.toMatch(/\n      stop_officer_shift:/);
  });

  it('keeps complete_officer_shift as the sole officer completion authority', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."complete_officer_shift"/,
    );
    expect(databaseTypes).toMatch(/\n      complete_officer_shift:/);
    expect(endShiftDialog).toContain("supabase.rpc('complete_officer_shift'");
    expect(endShiftDialog).toContain('p_expected_status: shiftStatus');
    expect(endShiftDialog).not.toContain("supabase.rpc('stop_officer_shift'");
  });

  it('preserves all end-of-shift checks and downstream state', () => {
    expect(completionAuthority).toContain('Submit the shift debrief before completing the shift');
    expect(completionAuthority).toContain('Complete or skip every shift stop');
    expect(completionAuthority).toContain('Complete or cancel every dispatch job');
    expect(completionAuthority).toContain('Resolve active welfare alerts');
    expect(completionAuthority).toContain(
      "update public.roster_slots set status='completed'",
    );
    expect(completionAuthority).toContain("'officer_shift_completed'");
    expect(endShiftDialog).toContain("supabase.rpc('get_shift_end_readiness'");
    expect(endShiftDialog).toContain("supabase.rpc('submit_shift_debrief'");
  });
});
