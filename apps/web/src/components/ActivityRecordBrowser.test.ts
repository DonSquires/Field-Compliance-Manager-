import { describe, expect, it } from 'vitest';
import { ACTIVITY_PAGE_SIZE, sanitiseSearchTerm } from '../lib/activitySearch';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const browserSource = readFileSync(resolve(process.cwd(), 'src/components/ActivityRecordBrowser.tsx'), 'utf8');
const vehicleSearchSource = readFileSync(resolve(process.cwd(), 'src/pages/VehicleSearchPage.tsx'), 'utf8');
const recordPdfSource = readFileSync(resolve(process.cwd(), '../../supabase/functions/generate-record-pdf/index.ts'), 'utf8');
const evidenceCaptureMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261010201209_preserve_external_evidence_capture_time.sql'), 'utf8');

describe('activity record search', () => {
  it('strips characters that would break or widen a PostgREST filter', () => {
    expect(sanitiseSearchTerm('abc,zone_id.eq.1)')).toBe('abc zone_id.eq.1');
    expect(sanitiseSearchTerm('  50%  *wild* ')).toBe('50 wild');
    expect(sanitiseSearchTerm('("x")')).toBe('x');
  });

  it('pages in a human-readable size', () => {
    expect(ACTIVITY_PAGE_SIZE).toBeGreaterThanOrEqual(10);
    expect(ACTIVITY_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it('routes only true canonical identifiers to canonical workspaces', () => {
    expect(browserSource).toContain('area=vehicle-search&vehicle=');
    expect(browserSource).toContain('area=observation-search&person=');
    expect(browserSource).toContain('Search recorded plate');
    expect(browserSource).not.toContain('selectedSighting.canonical_person_id || selectedSighting.person_record_id');
    expect(vehicleSearchSource).toContain("searchParams.get('vehicle')");
    expect(vehicleSearchSource).toContain("vehicleQuery.eq('id', canonicalVehicleId)");
  });

  it('generates a governed private PDF instead of injecting record HTML into a print window', () => {
    expect(browserSource).toContain("supabase.functions.invoke('generate-record-pdf'");
    expect(browserSource).not.toContain('document.write');
    expect(browserSource).not.toContain('printWindow.print');
    expect(recordPdfSource).toContain("from(table)");
    expect(recordPdfSource).toContain("storage.from(bucket).upload");
    expect(recordPdfSource).toContain("action: 'record_pdf_generated'");
    expect(recordPdfSource).toContain('createSignedUrl(path, 900)');
    expect(recordPdfSource).toContain('embedEvidenceImage');
    expect(recordPdfSource).toContain('embedPdfNotoFonts');
  });

  it('preserves known source capture time when an external photo is promoted', () => {
    expect(evidenceCaptureMigration).toContain('p_captured_at timestamptz DEFAULT NULL');
    expect(evidenceCaptureMigration).toContain('v_captured_at timestamptz := coalesce(p_captured_at, clock_timestamp())');
    expect(evidenceCaptureMigration).toContain("'source_captured_at', p_captured_at");
    expect(evidenceCaptureMigration).toContain('IF NOT public.org_access_allowed(v_org)');
  });
});
