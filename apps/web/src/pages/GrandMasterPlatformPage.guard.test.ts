import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: a negative assertion below embeds a literal '\n' for a multi-line pattern.
// Without normalising, git's CRLF checkout on Windows would make that pattern never match
// regardless of whether the bad code is genuinely absent - a silent false pass, not a real check.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const page = read('src/pages/GrandMasterPlatformPage.tsx');
const edge = read('../../supabase/functions/import-scv-csv/index.ts');

describe('grand master SCV infrastructure ownership', () => {
  it('keeps the import control on the grand master platform surface', () => {
    expect(page).toContain("const isGrandMaster = profile?.role === 'grand_master'");
    expect(page).toContain("supabase.functions.invoke<{ batch_id?: string; total_rows?: number; valid_rows?: number; invalid_rows?: number; status?: string }>('import-scv-csv'");
    expect(page).toContain('Import SCV CSV');
  });

  it('enforces grand master ownership at the edge boundary', () => {
    expect(edge).toContain("if (role !== 'grand_master')");
    expect(edge).toContain('grand_master infrastructure owner required');
    expect(edge).not.toContain("'admin',\n      'master',\n      'grand_master'");
  });
});