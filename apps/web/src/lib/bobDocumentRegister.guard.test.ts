import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-document-register/index.ts'), 'utf8');

describe('Bob document re-registration', () => {
  it('refreshes stale extraction state when a deduplicated source is re-registered', () => {
    expect(edge).toContain("admin.from('document_versions').update");
    expect(edge).toContain('extracted_text: extractedText');
    expect(edge).toContain('ocr_required: ocrRequired');
    expect(edge).toContain('extraction_confidence: extractionConfidence');
  });
});