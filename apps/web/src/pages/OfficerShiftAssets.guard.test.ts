import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerSchedulePage.tsx'), 'utf8');

describe('officer shift asset custody', () => {
  it('signs equipment out and back through the governed RPCs', () => {
    expect(source).toContain("supabase.rpc('assign_shift_asset'");
    expect(source).toContain("supabase.rpc('return_shift_asset'");
  });

  it('never writes the custody tables directly from the client', () => {
    expect(source).not.toMatch(/from\('shift_assets'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/);
    expect(source).not.toMatch(/from\('assets'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/);
  });

  it('sends an idempotency key so a repeated sign-out cannot double-issue an asset', () => {
    expect(source).toContain('p_client_request_id: crypto.randomUUID(), p_shift_id: activeShiftId');
  });

  it('only offers equipment that is actually available in the officer organisation', () => {
    expect(source).toContain("from('assets').select('id, name, asset_type, registration, serial_number')");
    expect(source).toContain("eq('status', 'available')");
  });

  it('only shows custody that is still open for the active shift', () => {
    expect(source).toContain("is('returned_at', null)");
    expect(source).toContain("shift.status === 'in_progress'");
  });

  it('requires a fault description before accepting a non-good return', () => {
    expect(source).toContain("if (returnCondition !== 'good' && !returnDefects.trim())");
    expect(source).toContain('Describe the fault so the workshop knows what to look at.');
  });

  it('tells the officer where the item went after a return', () => {
    expect(source).toContain('returned and sent to maintenance');
    expect(source).toContain('returned and back in the available pool');
  });

  it('reports an equipment load failure instead of showing an empty list', () => {
    expect(source).toContain("['shift equipment', assetError]");
  });
});
