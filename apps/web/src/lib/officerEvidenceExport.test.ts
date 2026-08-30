import { describe, expect, it } from 'vitest';
import { buildEvidenceExportFilename } from './officerEvidenceExport';

describe('officer evidence export download', () => {
  it('builds a filesystem-safe traceable filename', () => {
    expect(buildEvidenceExportFilename('Ana Ngata / Night Team', '2026-08-30T09:30:00Z', '9c3903f1-1234-4567-8901-123456789012'))
      .toBe('officer-activity-ana-ngata-night-team-2026-08-30-9c3903f1.json');
  });
});