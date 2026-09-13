import { describe, expect, it } from 'vitest';
import { parseCsvPreview, parseJsonPreview, parseXlsxPreview, sha256Hex } from './importPreview';

describe('CSV import preview', () => {
  it('detects mappings, date range, and duplicate rows without writing data', () => {
    const preview = parseCsvPreview('ID,RecordedDate,REGO,Title\n1,2026-01-02T11:00:00Z,Gpy30,Lowburn\n1,2026-01-02T11:00:00Z,Gpy30,Lowburn\n2,2026-01-31T11:00:00Z,Nla432,Lowburn\n', 'Vehicle Log.csv');
    expect(preview.row_count).toBe(3);
    expect(preview.duplicate_count).toBe(1);
    expect(preview.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'REGO', target: 'vehicle.registration' }),
      expect.objectContaining({ source: 'RecordedDate', target: 'observation.observed_at' }),
    ]));
    expect(preview.date_range).toContain('02/01/2026');
    expect(preview.warnings).toContain('Preview only: no canonical records will be written');
    expect(preview.headers).toEqual(['ID', 'RecordedDate', 'REGO', 'Title']);
    expect(preview.sample_rows).toHaveLength(3);
  });

  it('rejects an invalid XLSX payload safely before any promotion', async () => {
    await expect(parseXlsxPreview(new ArrayBuffer(0), 'Vehicle events.xlsx')).rejects.toBeTruthy();
  });

  it('creates a stable SHA-256 digest for source bytes', async () => {
    const bytes = new TextEncoder().encode('source-row').buffer as ArrayBuffer;
    await expect(sha256Hex(bytes)).resolves.toBe('e7b8190cd3763566ca3061365d327050fe7d6d7dcf3a51ebb5585150e40f5547');
  });

  it('separates malformed rows and unresolved mapped values from informational warnings', () => {
    const preview = parseCsvPreview('Registration,Site\nKDQ873,Lowburn\n,Lowburn\nBROKEN\n', 'quality.csv');
    expect(preview.malformed_row_count).toBe(1);
    expect(preview.unresolved_count).toBe(1);
    expect(preview.warnings).toContain('1 malformed rows have a different column count');
    expect(preview.warnings).toContain('1 rows have unresolved mapped values');
  });
});

describe('JSON import preview', () => {
  it('previews arrays and records containers without writing data', () => {
    const preview = parseJsonPreview(JSON.stringify({ generatedAt: '2026-04-23T06:48:14Z', records: [{ id: 'zone-1', name: 'Test zone', polygon: [[-41.3, 173.1]] }] }), 'client-geofence-registry.json');
    expect(preview.parser).toBe('JSON / schema detection');
    expect(preview.row_count).toBe(1);
    expect(preview.headers).toEqual(expect.arrayContaining(['id', 'name', 'polygon']));
    expect(preview.warnings).toContain('Preview only: no canonical records will be written');
  });
});
