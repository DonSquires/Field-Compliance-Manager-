import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/WelfareAlertsPage.tsx'), 'utf8');

describe('supervisor welfare response workbench', () => {
  it('loads tenant-scoped alerts and subscribes with the same tenant filter', () => {
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain('filter: `organization_id=eq.${profile.organizationId}`');
  });

  it('records distinct acknowledgement and resolution evidence', () => {
    expect(source).toContain('acknowledgement_notes: actionNotes.trim()');
    expect(source).toContain('resolution_notes: actionNotes.trim()');
    expect(source).toContain(".eq('status', 'pending')");
    expect(source).toContain(".in('status', ['pending', 'acknowledged'])");
    expect(source).toContain(".select('id')");
  });

  it('requires human notes and surfaces concurrent transition failures', () => {
    expect(source).toContain('required rows={4}');
    expect(source).toContain('This alert changed before your action was saved');
  });

  it('uses real phone and GPS actions rather than inert controls', () => {
    expect(source).toContain('href={`tel:');
    expect(source).toContain('https://www.google.com/maps?q=');
  });
});