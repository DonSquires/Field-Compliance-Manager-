import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/OfficerPatrolStops.tsx'), 'utf8');
const patrolPage = readFileSync(resolve(process.cwd(), 'src/pages/PatrolPage.tsx'), 'utf8');

describe('officer contracted stops', () => {
  it('reads and writes only through the governed officer RPCs', () => {
    expect(source).toContain("supabase.rpc('get_officer_patrol_stops', { p_shift_id: shiftId })");
    expect(source).toContain("supabase.rpc('manage_officer_patrol_stop'");
    expect(source).toContain('p_expected_status: stop.status');
    expect(source).toContain('p_request_id: pendingRequest.current[key]');
    expect(source).not.toContain("from('shift_stops')");
    expect(source).not.toContain('complete_shift_stop');
  });

  it('shows one current stop with its brief and one action at a time', () => {
    expect(source).toContain("const current = stops.find((stop) => stop.status === 'on_scene') ?? stops.find((stop) => stop.status === 'pending' || stop.status === 'en_route') ?? null;");
    expect(source).toContain("aria-current={isCurrent ? 'step' : undefined}");
    expect(source).toContain('<strong>Do here:</strong>');
    expect(source).toContain('<strong>Access:</strong>');
    expect(source).toContain('<strong>Safety:</strong>');
    expect(source).toContain('`Arrived at ${stop.place.name}`');
    expect(source).toContain('`Leaving ${stop.place.name}`');
  });

  it('is honest about GPS and timing instead of claiming verification', () => {
    expect(source).toContain("off_site: 'GPS placed you away from the site — recorded, not hidden'");
    expect(source).toContain("no_gps: 'No GPS position was available'");
    expect(source).toContain('Why you arrived after the contracted window');
    expect(source).toContain("(shorter than contracted)");
    expect(source).toContain('ask your supervisor to build the patrol run for the agreement');
  });

  it('is mounted on the officer patrol page for the selected shift', () => {
    expect(patrolPage).toContain("import { OfficerPatrolStops } from '../components/OfficerPatrolStops';");
    expect(patrolPage).toContain('<OfficerPatrolStops key={session.shift.id} shiftId={session.shift.id} />');
  });
});
