import { describe, expect, it } from 'vitest';
import { ACTIVITY_PAGE_SIZE, normaliseSearchTerm, sanitiseSearchTerm } from '../lib/activitySearch';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const browserSource = readFileSync(resolve(process.cwd(), 'src/components/ActivityRecordBrowser.tsx'), 'utf8');
const vehicleSearchSource = readFileSync(resolve(process.cwd(), 'src/pages/VehicleSearchPage.tsx'), 'utf8');
const recordPdfSource = readFileSync(resolve(process.cwd(), '../../supabase/functions/generate-record-pdf/index.ts'), 'utf8');
const searchMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261020171000_vehicle_owners_record_updates_activity_search.sql'), 'utf8');
const evidenceCaptureMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261010201209_preserve_external_evidence_capture_time.sql'), 'utf8');

describe('activity record search', () => {
  it('strips characters that would break or widen a PostgREST filter', () => {
    expect(sanitiseSearchTerm('abc,zone_id.eq.1)')).toBe('abc zone_id.eq.1');
    expect(sanitiseSearchTerm('  50%  *wild* ')).toBe('50 wild');
    expect(sanitiseSearchTerm('("x")')).toBe('x');
  });

  it('keeps typed punctuation for the parameterised full-text search and ignores one-letter terms', () => {
    expect(normaliseSearchTerm("  O'Brien   gate ")).toBe("O'Brien gate");
    expect(normaliseSearchTerm('a')).toBe('');
    expect(normaliseSearchTerm('RJ-298')).toBe('RJ-298');
  });

  it('searches every recorded field, updates and all dates through the governed RPC', () => {
    expect(browserSource).toContain("supabase.rpc('search_activity_records'");
    expect(browserSource).toContain('p_from: null, p_to: null');
    expect(browserSource).toContain('<RecordUpdatesPanel');
    expect(searchMigration).toContain('public.location_event_search_text(e.event_type, e.payload) ILIKE v_pattern');
    expect(searchMigration).toContain("r.record_kind = 'location_event' AND r.body ILIKE v_pattern");
    expect(searchMigration).toContain('org_access_allowed');
    expect(searchMigration).toContain('GRANT EXECUTE ON FUNCTION public.search_activity_records(text,uuid[],uuid[],text,timestamptz,timestamptz,integer,integer) TO authenticated');
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
