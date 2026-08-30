import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('field operations command surface', () => {
  it('replaces the exposed placeholder with the operational landing page', () => {
    expect(shell).toContain("case 'landing':");
    expect(shell).toContain('<FieldOperationsPage onNavigate={navigateToFieldOps} />');
    expect(shell).not.toContain('return <ComingSoonPage title="Field Operations" />');
  });

  it('provides interactive routes for each implemented operational workflow', () => {
    for (const area of ['dispatch', 'patrol', 'live-map', 'officer-activity', 'welfare-alerts', 'breach-review', 'vehicle-search', 'field-reports']) {
      expect(page).toContain(`area: '${area}'`);
    }
    expect(page).toContain('onClick={() => onNavigate(area)}');
  });

  it('uses independent live count queries with explicit unavailable state', () => {
    for (const table of ['shifts', 'dispatch_jobs', 'welfare_alerts', 'officer_field_reports']) {
      expect(page).toContain(`from('${table}')`);
    }
    expect(page).toContain('Some operational counts are unavailable');
  });
});