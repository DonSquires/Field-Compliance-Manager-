import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, 'PttOperationsPage.tsx'), 'utf8');

describe('PttOperationsPage data boundary', () => {
  it('uses only organization-scoped PTT evidence and admin-governed channel writes', () => {
    expect(source).toContain("from('ptt_channels')");
    expect(source).toContain("from('ptt_transmissions')");
    expect(source).toContain("from('radio_transcript_segments')");
    expect(source).toContain(".eq('organization_id', organizationId)");
    expect(source).toContain("event: '*', schema: 'public', table: 'ptt_transmissions'");
    expect(source).toContain(".insert({ organization_id: profile.organizationId");
  });
});