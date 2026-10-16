import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'apps/web/src')) ? resolve(process.cwd(), 'apps/web') : process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

const register = read('src/components/PlaceHazardRegister.tsx');
const briefing = read('src/components/ShiftSafetyBriefing.tsx');
const lib = read('src/lib/safetyBriefing.ts');
const schedule = read('src/pages/OfficerSchedulePage.tsx');
const stops = read('src/components/OfficerPatrolStops.tsx');
const shell = read('src/shells/OfficerShell.tsx');
const sitePage = read('src/pages/SiteDetailPage.tsx');

describe('place hazard register and officer safety briefing', () => {
  it('never writes place_hazards or acknowledgements directly', () => {
    for (const source of [register, briefing, lib, schedule, stops]) {
      expect(source).not.toMatch(/from\('place_hazards'\)/);
      expect(source).not.toMatch(/from\('safety_briefing_acknowledgements'\)/);
    }
    expect(register).toContain("rpc('manage_place_hazard'");
    expect(register).toContain("rpc('get_place_hazard_register'");
    expect(lib).toContain("rpc('acknowledge_safety_briefing'");
    expect(lib).toContain("rpc('report_place_hazard'");
  });

  it('asks for the briefing before a shift starts and on patrol arrival', () => {
    expect(schedule).toContain('fetchShiftSafetyBriefing(shift.id)');
    expect(schedule).toContain("I've read these risks – start shift");
    expect(schedule.indexOf('fetchShiftSafetyBriefing(shift.id)')).toBeLessThan(schedule.indexOf('await continueStart(shift);'));
    expect(stops).toContain('fetchShiftSafetyBriefing(shiftId, stop.id)');
    expect(shell).toContain('<OfficerSafetyBriefingBanner shift={activeShift} />');
    expect(sitePage).toContain('<PlaceHazardRegister');
  });

  it('opens source documents through a signed link only', () => {
    expect(lib).toContain("functions.invoke('place-hazard-source'");
    expect(lib).not.toMatch(/getPublicUrl/);
  });
});
