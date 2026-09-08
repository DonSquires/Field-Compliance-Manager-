import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/GrandMasterPlatformPage.tsx'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/import-scv-csv/index.ts'), 'utf8');

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