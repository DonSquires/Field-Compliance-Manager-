import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerSchedulePage.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');

describe('officer schedule workspace', () => {
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
});