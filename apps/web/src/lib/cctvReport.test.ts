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
    expect(report).toContain('Draft report');
    expect(report).toContain('job-1');
    expect(report).toContain('@page{size:A4;margin:16mm}');
    expect(report).toContain('thead{display:table-header-group}');
  });

  it('labels unresolved observations as a draft report', () => {
    const report = buildCCTVPrintableReport({
      title: 'CCTV evidence report (Draft)',
      reportStatus: 'draft',
      generatedAt: '2026-09-09T12:00:00.000Z',
      place: 'North gate',
      jobId: 'job-1',
      evidenceId: 'evidence-1',
      personCount: 1,
      vehicleCount: 0,
      frameCount: 1,
      observations: [{ kind: 'Person', label: 'Unknown', reviewState: 'Review required' }],
    });

    expect(report).toContain('Status: draft');
    expect(report).toContain('This report is not final compliance or incident evidence');
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

  it('renders a client assessment using What, When, Where, Why, and How', () => {
    const report = buildCCTVPrintableReport({
      title: 'CCTV evidence assessment',
      reportStatus: 'review_ready',
      generatedAt: '2026-09-09T12:00:00.000Z',
      place: 'North gate',
      jobId: 'job-1',
      evidenceId: 'evidence-1',
      personCount: 1,
      vehicleCount: 0,
      frameCount: 20,
      assessment: {
        what: 'One person observation was consolidated for review.',
        when: '4s to 9s in the reviewed footage.',
        where: 'North gate',
        why: 'Assess potential safety, security, or compliance concerns for the client.',
        how: 'Motion extraction and provisional detection followed by human review.',
      },
      observations: [],
    });

    expect(report).toContain('Client assessment');
    for (const heading of ['What', 'When', 'Where', 'Why', 'How']) {
      expect(report).toContain(`<dt>${heading}</dt>`);
    }
    expect(report).toContain('No breach or identity conclusion is inferred');
  });

  it('includes bounded evidence photos with provenance captions', () => {
    const report = buildCCTVPrintableReport({
      title: 'CCTV evidence assessment',
      generatedAt: '2026-09-09T12:00:00.000Z',
      place: 'North gate',
      jobId: 'job-1',
      evidenceId: 'evidence-1',
      personCount: 1,
      vehicleCount: 0,
      frameCount: 20,
      evidenceImages: [{
        kind: 'person',
        src: 'data:image/jpeg;base64,ZmFrZQ==',
        label: 'Person observation',
        timestampSeconds: 4.25,
        sha256Hash: 'abc123',
        reviewState: 'Confirmed',
      }],
      observations: [],
    });

    expect(report).toContain('Evidence photographs');
    expect(report).toContain('data:image/jpeg;base64,ZmFrZQ==');
    expect(report).toContain('4.25s');
    expect(report).toContain('Frame hash abc123');
    expect(report).toContain('Confirmed');
    expect(report).toContain('Entity: person');
  });
});
