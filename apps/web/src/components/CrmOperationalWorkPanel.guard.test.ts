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

  describe('agreement-scoped operational continuity', () => {
    it('loads the governed policy for an agreement location and module', () => {
      expect(source).toContain("from('service_agreement_continuity_policies').select(");
      expect(source).toContain("from('service_agreement_locations').select(");
      expect(source).toContain("from('service_agreement_modules').select(");
    });

    it('saves complete coverage and disclosure settings through the RPC', () => {
      expect(source).toContain("supabase.rpc('manage_service_agreement_continuity_policy'");
      expect(source).toContain('p_service_agreement_location_id: continuityForm.locationId');
      expect(source).toContain('p_service_agreement_module_id: continuityForm.moduleId');
      expect(source).toContain('p_share_attachments_mode: continuityForm.attachmentsMode');
      expect(source).toContain('Each coverage window needs both a start and an end');
      expect(source).toContain('History and handoff retention must each be a whole number from 1 to 168 hours.');
      expect(source).not.toMatch(/from\('service_agreement_continuity_policies'\)[\s\S]{0,300}\.(insert|update|upsert)\(/);
    });
  });

  describe('per-place toolset assignment', () => {
    it('resolves the Location house behind each agreement facet and reads its assignments', () => {
      expect(source).toContain(".from('client_sites').select('id,location_id')");
      expect(source).toContain(".from('location_zones').select('id,location_id')");
      expect(source).toContain(".from('locations').select('id,name')");
      expect(source).toContain(".from('location_module_assignments').select('id,location_id,module_key,service_agreement_id,enabled,effective_from,effective_to,updated_at')");
    });

    it('writes only through the governed replay-safe optimistic RPC', () => {
      expect(source).toContain("supabase.rpc('manage_location_module_assignment'");
      expect(source).toContain('p_client_request_id: crypto.randomUUID()');
      expect(source).toContain('p_expected_updated_at: toolsetForm.expectedUpdatedAt');
      expect(source).toContain('p_service_agreement_id: agreement.id');
      expect(source).not.toMatch(/from\('location_module_assignments'\)[\s\S]{0,300}\.(insert|update|upsert|delete)\(/);
    });

    it('confirms the change, offers a safe exit, and gives an audit receipt', () => {
      expect(source).toContain('Keep current setting');
      expect(source).toContain("'Confirm turn on'");
      expect(source).toContain("'Confirm turn off'");
      expect(source).toContain('An audit receipt was recorded. Next: officers at this place see this toolset on their next shift.');
      expect(source).toContain('The end date cannot be before the start date.');
    });

    it('states honestly when a place or module is missing instead of showing an empty grid', () => {
      expect(source).toContain('No Location house is reachable from this agreement yet. Link an active Site or Zone facet first.');
      expect(source).toContain('No module is enabled on this agreement yet. Use Configure coverage and modules first.');
      expect(source).toContain("'Not set at this place'");
    });
  });

  it('builds the run through the governed RPC and says what happens next', () => {    expect(source).toContain("supabase.rpc('create_patrol_route_from_agreement'");
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
