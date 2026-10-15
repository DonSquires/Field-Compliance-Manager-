import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const producer = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-propose-roster-fill/index.ts'), 'utf8');
const rollbackProducer = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-propose-roster-rollback/index.ts'), 'utf8');
const executor = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-proposal-execute/index.ts'), 'utf8');

describe('Bob roster proposal function', () => {
  it('creates pending plans without writing roster slots', () => {
    expect(producer).toContain("action_type: 'apply_roster_fill_plan'");
    expect(producer).toContain("status: 'pending'");
    expect(producer).toContain('get_bob_roster_fill_candidates');
    expect(producer).not.toContain("from('roster_slots').insert");
    expect(producer).toContain('publish_required: true');
  });

  it('supports human-approved apply and rollback through the executor', () => {
    expect(executor).toContain("'apply_roster_fill_plan'");
    expect(executor).toContain("'rollback_bob_roster_plan'");
    expect(executor).toContain("admin.rpc('apply_bob_roster_fill_plan'");
    expect(executor).toContain("admin.rpc('rollback_bob_roster_fill_plan'");
    expect(executor).toContain('A human must publish slots separately');
  });

  it('creates rollback proposals without mutating the roster directly', () => {
    expect(rollbackProducer).toContain("action_type: 'rollback_bob_roster_plan'");
    expect(rollbackProducer).toContain("status: 'pending'");
    expect(rollbackProducer).toContain("Only an applied roster plan can be rolled back");
    expect(rollbackProducer).not.toContain("from('roster_slots').update");
  });
});
