import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905007200_schedule_activates_patrol_config.sql'), 'utf8');

describe('accepted schedules reach the real patrol engine', () => {
  it('adds an idempotency key linking client_site_patrol_config back to its proposal schedule', () => {
    expect(migration).toContain('ADD COLUMN proposal_scope_schedule_id');
    expect(migration).toContain('idx_cspc_proposal_schedule');
  });

  it('maps the patrol capability to general_patrol and excludes ad hoc alarm response', () => {
    expect(migration).toContain("CASE schedule.capability_key WHEN 'patrol' THEN 'general_patrol'");
    expect(migration).toContain("schedule.capability_key<>'alarm_response'");
  });

  it('leaves patrol_route_id unset so a human still assigns the site into a patrol bucket', () => {
    expect(migration).not.toContain('patrol_route_id');
  });
});
