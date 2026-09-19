import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(resolve(process.cwd(), 'src/components/DeputyImportWizard.tsx'), 'utf8');
const roster = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');

describe('Deputy import walkthrough', () => {
  it('walks four steps and writes only through the governed import RPC', () => {
    expect(wizard).toContain("const STEPS = ['Files', 'People', 'Places', 'Review and import'] as const;");
    expect(wizard).toContain("supabase.rpc('apply_deputy_roster_import'");
    expect(wizard).not.toMatch(/from\('(roster_slots|roster_work_units|leave_requests|organization_workplaces)'\)[\s\S]{0,80}\.(insert|update|upsert)\(/);
    expect(wizard).toContain("from('staff_profiles').select('id,payroll_id,external_refs')");
  });

  it('matches people to existing staff only and says so in plain words', () => {
    expect(wizard).toContain('Nobody is created here');
    expect(wizard).toContain('<option value="">Not in your staff list</option>');
    expect(wizard).toContain("ref.external_refs?.deputy_export_code === person.exportCode || ref.payroll_id === person.exportCode");
    expect(wizard).toContain('norm(member.name) === norm(person.cleanName)');
  });

  it('lets internal work be created but makes patrol runs and static posts be picked from agreements', () => {
    expect(wizard).toContain("{guidance.canCreate && <option value=\"create_internal\">Create as internal work</option>}");
    expect(wizard).toContain('Patrol runs and static posts come from client agreements, so they are picked, not created.');
    expect(wizard).toContain("candidate.external_refs?.deputy?.code === location.code");
  });

  it('is honest about what is and is not imported and sends no sensitive columns', () => {
    expect(wizard).toContain('timesheet rows are counted in the batch but not turned into pay or attendance records yet.');
    expect(wizard).toContain('Importing the same file again will not create duplicates.');
    expect(wizard).toContain('dates of birth, contact details and pay are not.');
    expect(wizard).not.toMatch(/Date Of Birth|'Phone'|'Email'/);
  });

  it('is reachable from the roster page header', () => {
    expect(roster).toContain('Import from Deputy');
    expect(roster).toContain('<DeputyImportWizard');
    expect(roster).toContain("select('id,name,work_unit_type,service_type,external_refs')");
  });
});
