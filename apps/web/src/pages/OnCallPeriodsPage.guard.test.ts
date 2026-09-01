import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const officerSource = readFileSync(resolve(process.cwd(), 'src/pages/OfficerOnCallPage.tsx'), 'utf8');
const adminSource = readFileSync(resolve(process.cwd(), 'src/pages/OnCallPeriodsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');

describe('OfficerOnCallPage', () => {
  it('accepts/declines and logs callout milestones through the RPCs, not direct table writes', () => {
    expect(officerSource).toContain("supabase.rpc('respond_to_on_call_period'");
    expect(officerSource).toContain("supabase.rpc('log_callout_milestone'");
    expect(officerSource).toContain("supabase.rpc('submit_travel_allowance'");
    expect(officerSource).not.toContain("from('on_call_periods').update(");
    expect(officerSource).not.toContain("from('callout_shifts').insert(");
  });

  it('is reachable from the officer home quick actions', () => {
    expect(shell).toContain("case 'on_call':");
    expect(shell).toContain('<OfficerOnCallPage />');
    expect(home).toContain("onClick={() => onNavigate('on_call')}");
  });
});

describe('OnCallPeriodsPage', () => {
  it('creates on_call_periods via a direct insert, since RLS already grants org-admin write', () => {
    expect(adminSource).toContain("from('on_call_periods').insert(");
  });

  it('is wired as a field-ops sub-area reachable from the operations landing grid', () => {
    expect(adminShell).toContain("'on-call'");
    expect(adminShell).toContain("case 'on-call':");
    expect(adminShell).toContain('<OnCallPeriodsPage />');
    expect(fieldOps).toContain("area: 'on-call'");
  });
});
