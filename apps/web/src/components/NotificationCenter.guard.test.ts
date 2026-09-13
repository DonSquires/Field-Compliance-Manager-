import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/NotificationCenter.tsx'), 'utf8');

describe('enterprise notification center', () => {
  it('uses RLS-scoped notification reads and checked read-state writes', () => {
    expect(source).toContain(".from('notifications')");
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain(".update({ read_at: readAt })");
    expect(source).toContain(".is('read_at', null)");
    expect(source).toContain(".select('id')");
  });

  it('subscribes to tenant-filtered realtime changes', () => {
    expect(source).toContain("table: 'notifications'");
    expect(source).toContain('filter: `organization_id=eq.${profile.organizationId}`');
  });

  it('does not invent navigation internally', () => {
    expect(source).toContain('onNavigate?.(notification)');
    expect(source).not.toContain('window.location');
  });

  it('fails closed and explains unavailable tenant scope', () => {
    expect(source).toContain('setLoading(false);');
    expect(source).toContain('disabled={!profile?.organizationId}');
    expect(source).toContain('Notifications unavailable until organisation access is confirmed');
  });
});