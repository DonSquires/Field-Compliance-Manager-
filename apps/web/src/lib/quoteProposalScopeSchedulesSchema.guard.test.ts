import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905006500_quote_proposal_scope_schedules.sql'), 'utf8');

describe('multi-place proposal schedules', () => {
  it('allows multiple operational schedule rows beneath one quoted place scope', () => {
    expect(migration).toContain('quote_proposal_scope_schedules');
    expect(migration).toContain('proposal_scope_id');
    expect(migration).toContain('visits_per_shift');
    expect(migration).toContain('active_days integer[]');
  });

  it('models alarm response as event-driven capability and activates accepted schedules', () => {
    expect(migration).toContain("'alarm_response'");
    expect(migration).toContain("'Alarm response is an on-demand callout capability'");
    expect(migration).toContain('service_agreement_delivery_schedules');
  });
});