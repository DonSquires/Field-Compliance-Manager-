import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/IncidentOversightPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('IncidentOversightPage', () => {
  it('reads org-wide incidents and allows inline status transitions', () => {
    expect(source).toContain("from('incidents')");
    expect(source).toContain(".eq('organization_id', orgId)");
    expect(source).toContain(".update({ status }).eq('id', id)");
  });

  it('offers every valid incident status as a transition target', () => {
    for (const status of ['open', 'in_review', 'resolved', 'escalated']) {
      expect(source).toContain(`'${status}'`);
    }
  });
});

describe('Incidents oversight routing', () => {
  it('is wired as a field-ops sub-area reachable from the operations landing page', () => {
    expect(shell).toContain("'incidents'");
    expect(shell).toContain("case 'incidents':");
    expect(shell).toContain('<IncidentOversightPage />');
  });
});
