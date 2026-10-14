import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => readFileSync(resolve(process.cwd(), '../..', path), 'utf8');
const schema = root('supabase/schema.sql');
const types = root('src/types/database.ts');
const retirement = root('supabase/migrations/20261014130000_retire_superseded_sla_arrival.sql');

describe('direct SLA clock arrival stays retired', () => {
  it('drops the superseded direct clock writer', () => {
    expect(retirement).toContain('DROP FUNCTION IF EXISTS public.record_sla_arrival(');
    expect(schema).not.toContain('CREATE OR REPLACE FUNCTION "public"."record_sla_arrival"(');
    expect(schema).not.toContain('ON FUNCTION "public"."record_sla_arrival"(');
    expect(types).not.toContain('      record_sla_arrival: {');
  });

  it('keeps dispatch attendance as the authoritative SLA arrival path', () => {
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."arrive_at_dispatch_place"(');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."advance_dispatch_job_status"(');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."dispatch_job_create_sla_clock"()');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."tg_dispatch_job_close_sla_clock"()');
    expect(schema).toContain(
      'CREATE TRIGGER "trg_dispatch_job_close_sla_clock" AFTER UPDATE OF on_scene_at, status ON public."dispatch_jobs"',
    );
  });
});
