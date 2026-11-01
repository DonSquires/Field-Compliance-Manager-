import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWriteOrDestructiveAction } from '../lib/humanTestActionPolicy';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CCTVQualityPage.tsx'), 'utf8');
const consolePage = readFileSync(resolve(process.cwd(), 'src/pages/CCTVConsolePage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const access = readFileSync(resolve(process.cwd(), 'src/lib/fieldOpsAreaAccess.ts'), 'utf8');

describe('CCTV detection quality', () => {
  it('is a CCTV-gated field-ops area routed through the admin shell', () => {
    expect(shell).toContain("case 'cctv-quality':");
    expect(shell).toContain('<CCTVQualityPage />');
    expect(access).toContain("'cctv-quality'");
  });

  it('measures quality only from the governed summary and reviewer decisions, scoped to the organisation', () => {
    expect(page).toContain("supabase.rpc('cctv_accuracy_summary', { p_organization_id: organizationId, p_since: since })");
    expect(page).toContain(".from('cctv_missed_detection_reports')");
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(page).toContain('accuracyByKind(summary, CURRENT_ENGINE_VERSION)');
    expect(page).toContain('proven precision (lower bound)');
  });

  it('changes state only through governed RPCs and never writes the quality tables directly', () => {
    expect(page).toContain("supabase.rpc('resolve_cctv_missed_detection'");
    expect(page).toContain("supabase.rpc('set_cctv_inference_policy'");
    expect(page).not.toMatch(/from\('cctv_(missed_detection_reports|inference_policies|cloud_inference_receipts)'\)[\s\S]{0,300}\.(update|insert|upsert|delete)\(/);
  });

  it('keeps cloud vehicle hints off by default, admin-only, and reasoned when enabled', () => {
    expect(page).toContain("'Off · nothing leaves your infrastructure'");
    expect(page).toContain("isAdmin && !policyDraft");
    expect(page).toContain("if (policyDraft.enabled && !policyDraft.reason.trim())");
    expect(page).toContain('every number plate blacked out');
  });

  it('says plainly when the quality measurement is not installed yet instead of showing a raw database error', () => {
    expect(page).toMatch(/could not find the function\|pgrst202/);
    expect(page).toContain('Detection quality measurement is not installed on this environment yet');
  });

  it('labels every write so the Dr Bob human-test walker never presses it, while navigation and form-opening stay walkable', () => {
    for (const label of ['Save resolution', 'Save policy', 'Resolve…', 'Record missed sighting']) {
      expect(isWriteOrDestructiveAction(label)).toBe(true);
    }
    for (const label of ['Review queue', 'Detection quality', 'Watch footage', 'Change…', 'Report a missed sighting', 'Refresh']) {
      expect(isWriteOrDestructiveAction(label)).toBe(false);
    }
    expect(page).toContain('Save resolution');
    expect(page).toContain('Save policy');
    expect(page).toContain('Resolve…');
  });
});

describe('CCTV console missed-sighting report', () => {
  it('reports a miss through the governed RPC with the clip offset, never a direct insert', () => {
    expect(consolePage).toContain("supabase.rpc('report_cctv_missed_detection'");
    expect(consolePage).toContain('p_offset_seconds');
    expect(consolePage).toContain('aria-label="Report a missed sighting"');
    expect(consolePage).toContain('Record missed sighting');
    expect(consolePage).not.toMatch(/from\('cctv_missed_detection_reports'\)[\s\S]{0,300}\.insert\(/);
  });

  it('links the console to the review queue and detection quality', () => {
    expect(consolePage).toContain("area=cctv-triage");
    expect(consolePage).toContain("area=cctv-quality");
  });
});
