import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerActivityTimelinePage.tsx'), 'utf8');

describe('officer activity evidence export UI', () => {
  it('uses the server export RPC and downloads its exact package text', () => {
    expect(source).toContain("supabase.rpc('generate_officer_activity_evidence_export'");
    expect(source).toContain('downloadEvidencePackage(');
    expect(source).toContain('receipt.package_text,');
    expect(source).not.toContain('JSON.stringify(receipt.package_text');
  });

  it('exposes the server export ID and digest receipt', () => {
    expect(source).toContain('exportReceipt.exportId');
    expect(source).toContain('exportReceipt.sha256');
  });
});