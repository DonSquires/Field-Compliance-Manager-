import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CCTVTriagePage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');
const lib = readFileSync(resolve(process.cwd(), 'src/lib/cctvConsole.ts'), 'utf8');

describe('CCTV observation triage', () => {
  it('is wired into field ops as its own nav area, separate from the wall/playback console', () => {
    expect(fieldOps).toContain("area: 'cctv-triage', label: 'Review observations'");
    expect(shell).toContain("case 'cctv-triage':");
    expect(shell).toContain('<CCTVTriagePage />');
    expect(shell).toContain("'cctv-triage'");
  });

  it('loads observations across every camera in the organisation, not scoped to one selected import', () => {
    expect(page).toContain("from('cctv_entity_observations').select(OBSERVATION_SELECT).eq('organization_id', organizationId)");
    expect(page).not.toContain(".eq('cctv_import_id',");
    expect(page).toContain("from('cctv_imports').select(");
    expect(page).toContain("text: 'Organisation access could not be confirmed. The observation queue is unavailable.'");
  });

  it('shares the same row-mapping contract as the console instead of re-deriving it', () => {
    expect(lib).toContain('export function toObservation(row: Record<string, unknown>): ConsoleObservation | null {');
    expect(lib).toContain('export const OBSERVATION_SELECT =');
    expect(page).toContain('.map(toObservation)');
  });

  it('records every decision through the governed review RPCs and never writes CCTV or registry tables directly', () => {
    expect(page).toContain("supabase.rpc('review_cctv_entity_observation'");
    expect(page).toContain("supabase.rpc('confirm_cctv_vehicle_attributes'");
    expect(page).toContain("supabase.rpc('confirm_cctv_weapon_hint'");
    expect(page).toContain("supabase.rpc('update_cctv_person_profile'");
    expect(page).toContain("supabase.rpc('update_cctv_vehicle_notes'");
    expect(page).not.toMatch(/from\('cctv_entity_observations'\)[\s\S]{0,400}\.(update|insert|delete)\(/);
    expect(page).not.toContain("from('canonical_vehicles')");
    expect(page).not.toContain("from('person_records')");
  });

  it('lets a reviewer record a person category and a persistent vehicle note beyond just a name', () => {
    expect(page).toContain('Category');
    expect(page).toContain('Person of interest');
    expect(page).toContain('if (personCategory.trim()) profileDetails.category = personCategory.trim();');
    expect(page).toContain('Vehicle note');
    expect(page).toContain('Save vehicle note');
    expect(page).toContain("supabase.rpc('get_cctv_vehicle_note'");
    expect(lib).not.toContain('canonical_vehicles(notes)');
  });

  it('never turns a weapon hint into an automated alert - only a recorded human confirm/dismiss decision', () => {
    expect(page).toContain("runWeaponHintReview(selected, 'confirmed')");
    expect(page).toContain("runWeaponHintReview(selected, 'dismissed')");
    expect(page).not.toMatch(/weapon[\s\S]{0,200}\b(notify|alert\(|sendMessage|escalate)\b/i);
  });

  it('explains data-service faults with a retry and refreshes on realtime changes for the whole organisation', () => {
    expect(page).toContain('describeConsoleFailure(');
    expect(page).toContain('retry: () => void load()');
    expect(page).toContain("channel(`cctv-triage-${organizationId}`)");
    expect(page).toContain("table: 'cctv_entity_observations', filter: `organization_id=eq.${organizationId}`");
  });

  it('lets a reviewer jump back to the wall to watch the source footage for a selected sighting', () => {
    expect(page).toContain('/admin/field-ops?area=cctv-console&import=${selected.importId}');
  });
});
