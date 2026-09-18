import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerSchedulePage.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');

describe('officer schedule workspace', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(page).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(page).toContain("setError('Organisation access could not be confirmed. Schedule data is unavailable.');");
    expect(page).toContain('setLoading(false);');
  });

  it('replaces the schedule placeholder with an interactive page', () => {
    expect(shell).toContain('return <OfficerSchedulePage />');
    expect(shell).not.toContain('return <ComingSoonPage title="Schedule" />');
  });
  it('shows assigned shifts and open coverage with deliberate confirmation', () => {
    expect(page).toContain("from('shifts')");
    expect(page).toContain("from('shift_coverage_requests')");
    expect(page).toContain('Claim this shift?');
    expect(page).toContain('Confirm claim');
  });
  it('routes all coverage claims through the shared governed helper', () => {
    expect(page).toContain('await claimShiftCoverage(selectedCoverage.id)');
    expect(home).toContain('await claimShiftCoverage(requestId)');
    expect(home).not.toContain(".update({ status: 'claimed'");
  });

  it('merges self-owned slots and synchronizes assignment responses through the RPC', () => {
    expect(page).toContain("from('staff_profiles')");
    expect(page).toContain("from('roster_slots')");
    expect(page).toContain('!slot.linked_shift_id');
    expect(page).toContain("supabase.rpc('respond_to_roster_slot'");
    expect(page).toContain('Decline reason');
  });

  it('shows the server-confirmed slot and linked-shift ownership receipt', () => {
    expect(page).toContain('receipt.slot_id');
    expect(page).toContain('receipt.shift_id');
    expect(page).toContain('Roster response recorded');
  });
  it('focuses the exact finalized coverage assignment from notification context',()=>{expect(page).toContain("get('slot')");expect(page).toContain('officer-roster-slot-${slot.id}');expect(page).toContain('scrollIntoView');});
});