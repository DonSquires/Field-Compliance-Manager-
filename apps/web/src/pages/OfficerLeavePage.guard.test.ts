import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerLeavePage.tsx'), 'utf8');

describe('officer leave submission', () => {
  it('uses a stable retry identity and self-owned RPC', () => {
    expect(page).toContain('eventIdRef.current');
    expect(page).toContain("supabase.rpc('submit_officer_leave_request'");
    expect(page).not.toContain(".from('leave_requests').insert");
  });
});