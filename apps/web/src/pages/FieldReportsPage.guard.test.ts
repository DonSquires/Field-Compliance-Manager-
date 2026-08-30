import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/FieldReportsPage.tsx'), 'utf8');

describe('field report review workbench', () => {
  it('uses only the governed review RPC for lifecycle transition', () => {
    expect(source).toContain("supabase.rpc('review_officer_field_report'");
    expect(source).not.toContain(".update({ status: 'reviewed'");
  });

  it('requires review notes and sends the expected current status', () => {
    expect(source).toContain('p_expected_status: selected.status');
    expect(source).toContain('p_review_notes: reviewNotes.trim()');
    expect(source).toContain('!reviewNotes.trim()');
  });

  it('exposes searchable filters, reviewer provenance, and checked feedback', () => {
    expect(source).toContain('Search reports or officers');
    expect(source).toContain('selected.review_notes');
    expect(source).toContain('Review recorded with supervisor notes and audit provenance.');
  });
});
