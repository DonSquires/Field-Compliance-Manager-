import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/PatrolPage.tsx'), 'utf8');

describe('patrol workspace', () => {
  it('fails closed when officer organisation context is unavailable', () => {
    expect(source).toContain("if (!profile?.id || !profile.organizationId) {");
    expect(source).toContain("setError('Organisation access could not be confirmed. Patrol data is unavailable.');");
    expect(source).toContain('setLoading(false);');
  });

  it('drives the whole patrol lifecycle through the governed RPCs', () => {
    expect(source).toContain("supabase.rpc('start_patrol_session'");
    expect(source).toContain("supabase.rpc('record_patrol_checkpoint_visit'");
    expect(source).toContain("supabase.rpc('complete_patrol_session'");
  });

  it('never writes the patrol tables directly from the client', () => {
    expect(source).not.toMatch(/from\('patrols'\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/);
    expect(source).not.toMatch(/from\('patrol_checkpoint_visits'\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/);
  });

  it('sends the checkpoint kind so route and site checkpoints resolve to the right column', () => {
    expect(source).toContain('p_checkpoint_kind: checkpoint.kind');
    expect(source).toContain("kind: 'route' as const");
    expect(source).toContain("kind: 'site' as const");
    expect(source).toContain('route_checkpoint_id');
  });

  it('requires a real GPS fix rather than falling back to an unverified manual visit', () => {
    expect(source).toContain('p_gps_accuracy: position.coords.accuracy');
    expect(source).not.toContain('allowManualFallback');
    expect(source).not.toContain('evaluateCheckpointVisit');
    expect(source).toContain('Location permission is blocked');
  });

  it('confirms completion and reports an already-recorded checkpoint instead of failing silently', () => {
    expect(source).toContain('Complete this patrol session?');
    expect(source).toContain('was already recorded for this patrol');
    expect(source).toContain('result.created');
  });
});
