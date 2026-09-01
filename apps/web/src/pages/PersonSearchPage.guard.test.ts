import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const adminPage = readFileSync(resolve(process.cwd(), 'src/pages/PersonSearchPage.tsx'), 'utf8');
const officerPage = readFileSync(resolve(process.cwd(), 'src/pages/OfficerPersonLookupPage.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const officerShell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');

describe('PersonSearchPage (admin)', () => {
  it('searches the persons registry and reads/writes person entity_flags', () => {
    expect(adminPage).toContain("from('persons')");
    expect(adminPage).toContain("from('entity_flags')");
    expect(adminPage).toContain("eq('entity_type', 'person')");
    expect(adminPage).toContain("entity_type: 'person'");
  });

  it('supports resolving an active flag', () => {
    expect(adminPage).toContain("update({ active: false, resolved_at: new Date().toISOString() })");
  });
});

describe('OfficerPersonLookupPage', () => {
  it('is read-only against persons and active person flags', () => {
    expect(officerPage).toContain("from('persons')");
    expect(officerPage).toContain("from('entity_flags')");
    expect(officerPage).toContain("eq('active', true)");
    expect(officerPage).not.toContain(".insert(");
  });
});

describe('Person search / lookup routing', () => {
  it('is wired as an admin field-ops sub-area reachable from the field ops landing grid', () => {
    expect(adminShell).toContain("'person-search'");
    expect(adminShell).toContain("case 'person-search':");
    expect(adminShell).toContain('<PersonSearchPage />');
    expect(fieldOps).toContain("area: 'person-search'");
  });

  it('is wired as an officer module reachable from the home quick actions', () => {
    expect(officerShell).toContain("'person_lookup'");
    expect(officerShell).toContain("case 'person_lookup':");
    expect(officerShell).toContain('<OfficerPersonLookupPage />');
    expect(home).toContain("onClick={() => onNavigate('person_lookup')}");
  });
});
