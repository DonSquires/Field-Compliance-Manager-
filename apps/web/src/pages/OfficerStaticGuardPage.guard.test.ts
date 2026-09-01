import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerStaticGuardPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');

describe('OfficerStaticGuardPage', () => {
  it('reads shift_stops for the officer\'s own accepted/in-progress shifts, not dispatch_jobs', () => {
    expect(source).toContain("from('shifts')");
    expect(source).toContain("in('status', ['accepted', 'in_progress'])");
    expect(source).toContain("from('shift_stops')");
    expect(source).toContain("eq('module_key', 'static_guarding')");
  });

  it('advances stop status through the server-owned RPC rather than writing shift_stops directly', () => {
    expect(source).toContain("supabase.rpc('advance_shift_stop_status'");
    expect(source).toContain('p_expected_status: stop.status');
    expect(source).not.toContain("from('shift_stops').update(");
  });

  it('excludes already-terminal stops from the working list', () => {
    expect(source).toContain("not('status', 'in', '(completed,skipped,cancelled)')");
  });
});

describe('Static guard officer routing', () => {
  it('replaces the dispatch-job fallback with the dedicated static guard page', () => {
    expect(shell).toContain("case 'site_guard':");
    expect(shell).toContain('<OfficerStaticGuardPage />');
  });
});
