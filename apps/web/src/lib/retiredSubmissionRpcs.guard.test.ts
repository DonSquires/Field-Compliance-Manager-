import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (p: string) => readFileSync(resolve(process.cwd(), '../..', p), 'utf8');
const schema = root('supabase/schema.sql');
const types = root('src/types/database.ts');
const retirement = root('supabase/migrations/20261014120000_retire_superseded_submission_rpcs.sql');

// Each retired name is paired with the governed authority that replaced it, so a
// regression that reinstates the old writer is reported against its successor.
const RETIRED: Array<[string, string]> = [
  ['submit_officer_timesheet', 'submit_officer_timesheet_from_work'],
  ['submit_noise_assessment', 'submit_officer_noise_assessment_v2'],
  ['submit_smoke_assessment', 'submit_smoke_assessment_receipt_v2'],
];

describe('superseded submission RPCs stay retired', () => {
  it('drops every retired function in the retirement migration', () => {
    for (const [name] of RETIRED) expect(retirement).toContain(`DROP FUNCTION IF EXISTS public.${name}(`);
  });

  it('leaves no definition or grant for a retired function in the live schema snapshot', () => {
    for (const [name] of RETIRED) {
      expect(schema).not.toContain(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
      expect(schema).not.toContain(`ON FUNCTION "public"."${name}"(`);
    }
  });

  it('keeps the governed successor for every retired function', () => {
    for (const [, successor] of RETIRED) expect(schema).toContain(`CREATE OR REPLACE FUNCTION "public"."${successor}"(`);
  });

  it('removes the retired functions from the generated client types', () => {
    for (const [name] of RETIRED) expect(types).not.toContain(`      ${name}: {`);
    expect(types).toContain('      submit_officer_timesheet_from_work: {');
  });
});
