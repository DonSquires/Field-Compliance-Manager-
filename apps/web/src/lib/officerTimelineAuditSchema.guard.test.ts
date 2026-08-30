import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830120000_audit_officer_timeline_access.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('officer timeline chain of custody', () => {
  it('keeps the source query private and exposes only the audited wrapper', () => {
    expect(migration).toContain('rename to get_officer_activity_timeline_unlogged');
    expect(migration).toContain('revoke all on function public.get_officer_activity_timeline_unlogged');
    expect(migration).toContain('grant execute on function public.get_officer_activity_timeline');
    expect(schema).toContain('REVOKE ALL ON FUNCTION "public"."get_officer_activity_timeline_unlogged"');
  });

  it('atomically records the actor, subject, query window, and result count', () => {
    expect(migration).toContain("'officer_activity_timeline_viewed'");
    expect(migration).toContain('actor_user_id');
    expect(migration).toContain("'event_count', v_event_count");
    expect(migration).toContain("'effective_limit'");
  });
});