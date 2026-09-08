import { describe, expect, it } from 'vitest';
import { parseCsvPreview, parseXlsxPreview } from './importPreview';

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
  });

  it('rejects an invalid XLSX payload safely before any promotion', async () => {
    await expect(parseXlsxPreview(new ArrayBuffer(0), 'Vehicle events.xlsx')).rejects.toBeTruthy();
  });
});
