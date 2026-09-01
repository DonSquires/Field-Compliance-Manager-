import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901013000_quarantine_dormant_incidents.sql'), 'utf8');

describe('single incident reporting architecture', () => {
  it('keeps dormant incident storage read-only for authenticated reporting', () => {
    for (const table of ['incidents', 'incident_attachments']) {
      expect(sql).toContain(`revoke all on table public.${table} from public,anon`);
      expect(sql).toContain(`revoke all on table public.${table} from authenticated`);
      expect(sql).toContain(`grant select on table public.${table} to authenticated`);
    }
  });

  it('preserves backend ownership without presenting dormant storage as a portal workflow', () => {
    expect(sql).toContain('grant all on table public.incidents,public.incident_attachments to service_role');
  });
});