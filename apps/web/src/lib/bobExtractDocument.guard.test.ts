import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-extract-document/index.ts'), 'utf8');

describe('Bob PDF extraction', () => {
  it('uses a real PDF text extractor before marking a document as OCR-required', () => {
    expect(edge).toContain("unpdf@0.12.1?target=deno");
    expect(edge).toContain('getDocumentProxy(bytes)');
    expect(edge).toContain('extractPdfTextContent(document');
    expect(edge).toContain('text = await extractPdfText(bytes)');
  });
});