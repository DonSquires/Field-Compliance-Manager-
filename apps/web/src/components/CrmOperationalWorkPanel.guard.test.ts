import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CrmOperationalWorkPanel.tsx'), 'utf8');

describe('patrol run from an accepted agreement', () => {
  it('reads the accepted quote schedules and whether each place is on a run yet', () => {
    expect(source).toContain(".from('service_agreement_delivery_schedules').select('id,proposal_scope_schedule_id,site_id,zone_id,capability_key,work_model,active_days,visits_per_shift,window_start,window_end,dwell_minutes,response_sla_minutes,officer_instructions')");
    expect(source).toContain(".from('client_site_patrol_config').select('id,proposal_scope_schedule_id,patrol_route_id')");
    expect(source).toContain("schedule.capability_key !== 'alarm_response'");
  });

  it('builds the run through the governed RPC and says what happens next', () => {
    expect(source).toContain("supabase.rpc('create_patrol_route_from_agreement'");
    expect(source).toContain('p_service_agreement_id: agreement.id');
    expect(source).toContain('Next: add a work unit so it can be rostered.');
    expect(source).not.toMatch(/from\('patrol_routes'\)[\s\S]{0,120}\.insert\(/);
    expect(source).not.toMatch(/from\('client_site_patrol_config'\)[\s\S]{0,120}\.update\(/);
  });

  it('walks the admin through places, run, and work unit in plain words', () => {
    expect(source).toContain('<strong>Places and times</strong>');
    expect(source).toContain('<strong>Patrol run</strong>');
    expect(source).toContain('<strong>Work unit for rostering</strong>');
    expect(source).toContain('No scheduled places on this agreement yet. Add delivery schedules in the quote, or raise a variation, and accept it.');
    expect(source).toContain("'Build patrol run'");
    expect(source).toContain("'Add the new places to the run'");
    expect(source).toContain('Add work unit for this run');
    expect(source).toContain("const describeDays = (days: number[]) => sentenceCase(contractedDaysWords(days));");
  });
});
