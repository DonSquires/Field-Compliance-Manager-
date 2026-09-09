import { describe, expect, it } from 'vitest';
import { buildCCTVPrintableReport } from './cctvReport';

describe('buildCCTVPrintableReport', () => {
  it('includes provenance, observations, and the human authority boundary', () => {
    const report = buildCCTVPrintableReport({
      title: 'CCTV evidence report',
      generatedAt: '2026-09-09T12:00:00.000Z',
      place: 'North gate',
      jobId: 'job-1',
      evidenceId: 'evidence-1',
      batchId: 'batch-1',
      clipCount: 3,
      personCount: 1,
      vehicleCount: 2,
      frameCount: 40,
      observations: [{
        kind: 'Person',
        label: '<Unknown person>',
        confidence: 0.81,
        startSeconds: 4,
        endSeconds: 9,
        reviewState: 'Draft match',
      }],
    });

    expect(report).toContain('North gate');
    expect(report).toContain('batch-1 (3 clips)');
    expect(report).toContain('&lt;Unknown person&gt;');
    expect(report).toContain('Human review boundary');
    expect(report).toContain('job-1');
  });

  it('marks a batch report partial when the queue has not loaded every clip', () => {
    const report = buildCCTVPrintableReport({
      title: 'CCTV evidence report',
      generatedAt: '2026-09-09T12:00:00.000Z',
      place: 'North gate',
      jobId: 'job-1',
      evidenceId: 'evidence-1',
      batchId: 'batch-1',
      clipCount: 3,
      loadedClipCount: 1,
      batchComplete: false,
      personCount: 0,
      vehicleCount: 0,
      frameCount: 0,
      observations: [],
    });

    expect(report).toContain('PARTIAL: 1 clips loaded');
  });
});
