import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerIncidentPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');

describe('OfficerIncidentPage', () => {
  it('writes directly to the structured incidents register, anchored to a client site', () => {
    expect(source).toContain("from('incidents')");
    expect(source).toContain('client_site_id: form.client_site_id');
    expect(source).toContain('officer_user_id: profile.id');
  });

  it('reads only the signed-in officer\'s own incident history', () => {
    expect(source).toContain(".eq('officer_user_id', profile.id)");
  });

  it('sources site options from client_sites', () => {
    expect(source).toContain("from('client_sites')");
  });
});

describe('Incident report officer routing', () => {
  it('is wired as an officer module reachable from the home quick actions', () => {
    expect(shell).toContain("'incident_report'");
    expect(shell).toContain("case 'incident_report':");
    expect(shell).toContain('<OfficerIncidentPage />');
    expect(home).toContain("onClick={() => onNavigate('incident_report')}");
  });
});
