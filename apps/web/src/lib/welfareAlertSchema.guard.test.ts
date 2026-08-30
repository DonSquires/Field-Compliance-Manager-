import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830080000_enforce_welfare_alert_status.sql'), 'utf8');

describe('welfare alert lifecycle schema', () => {
  it('enforces pending, acknowledged, and resolved as the only statuses', () => {
    for (const status of ['pending', 'acknowledged', 'resolved']) {
      expect(schema).toMatch(new RegExp(`welfare_alerts_status_check[\\s\\S]*?'${status}'`));
      expect(migration).toContain(`'${status}'::text`);
    }
  });
});