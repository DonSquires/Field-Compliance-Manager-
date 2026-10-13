import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/InvestigationPage.tsx'), 'utf8');

describe('investigation timeline', () => {
  it('records human-authored events through the governed command', () => {
    expect(source).toContain("supabase.rpc('add_investigation_event'");
    expect(source).toContain('p_investigation_id: investigation.id');
    expect(source).toContain('p_event_type: eventType.trim()');
    expect(source).toContain('p_description: eventDescription.trim()');
  });

  it('requires a description and surfaces persisted feedback', () => {
    expect(source).toContain('disabled={saving || !eventDescription.trim()}');
    expect(source).toContain('Investigation timeline event recorded.');
    expect(source).toContain('await load();');
  });
});
