import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830071000_align_notification_categories.sql'), 'utf8');

describe('notification producer schema contract', () => {
  it('allows categories emitted by roster and open-shift triggers', () => {
    for (const category of ['roster', 'open_job', 'report_reviewed']) {
      expect(schema).toMatch(new RegExp(`notifications_category_check[\\s\\S]*?'${category}'`));
      if (category !== 'report_reviewed') expect(migration).toContain(`'${category}'::text`);
    }
  });
});