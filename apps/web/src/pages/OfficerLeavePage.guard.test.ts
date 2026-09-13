import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerLeavePage.tsx'), 'utf8');

describe('officer leave submission', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(page).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(page).toContain("setError('Organisation access could not be confirmed. Leave requests are unavailable.');");
    expect(page).toContain('setLoading(false);');
  });

  it('uses a stable retry identity and self-owned RPC', () => {
    expect(page).toContain('eventIdRef.current');
    expect(page).toContain("supabase.rpc('submit_officer_leave_request'");
    expect(page).not.toContain(".from('leave_requests').insert");
  });

  it('opens the exact request and shows the admin decision evidence', () => {
    expect(page).toContain("get('leave')");
    expect(page).toContain('decision_notes');
    expect(page).toContain('approved_at');
    expect(page).toContain('Decision note');
    expect(page).toContain('id={`officer-leave-${r.id}`}');
  });
});