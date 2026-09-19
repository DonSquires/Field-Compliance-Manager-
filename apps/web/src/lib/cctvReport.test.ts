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

  it('prints the receipt the database issued, with the server provenance and an honest review-consistency line', () => {
    const base = { title: 'CCTV evidence report', generatedAt: '2026-09-18T12:00:00.000Z', place: 'Gate', jobId: 'job-1', evidenceId: 'ev-1', personCount: 1, vehicleCount: 0, frameCount: 10, observations: [], reportStatus: 'review_ready' as const };
    const report = buildCCTVPrintableReport({
      ...base,
      receipt: {
        reportId: '11111111-2222-3333-4444-555555555555',
        issuedAt: '2026-09-18T12:00:01Z',
        sha256: 'ab'.repeat(32),
        provenance: {
          evidence: { sha256_hash: 'cd'.repeat(32), locked_at: '2026-09-18T11:00:00Z', is_court_ready: true, integrity_state: 'verified', integrity_checked_at: '2026-09-18T11:30:00Z', source_size_bytes: 268435456 },
          import: { camera_label: 'Gate camera', source_device_kind: 'tapo', source_timezone: 'Pacific/Auckland', place_name: 'Depot', place_address: '1 Yard Road' },
          result: { classification_plan: { policy: 'detector_triage_then_one_full_recognition_per_unique_observation', sampled_frames: 120, representative_frames: 3 } },
          review: { observations_total: 4, accepted: 2, rejected: 1, unreviewed: 1, undecided: 0, legacy_decisions: 0 },
          review_consistency: 'client_claims_review_ready_but_database_holds_undecided_sightings',
          supersedes: { receipt_id: '99999999-2222-3333-4444-555555555555', issued_at: '2026-09-17T09:00:00Z', earlier_receipts: 1 },
        },
      },
    });
    expect(report).toContain('Report receipt');
    expect(report).toContain('11111111-2222-3333-4444-555555555555');
    expect(report).toContain('ab'.repeat(32));
    expect(report).toContain('cd'.repeat(32));
    expect(report).toContain('Locked 2026-09-18T11:00:00Z (court-ready; retention hold)');
    expect(report).toContain('Gate camera (tapo) at Depot, 1 Yard Road');
    expect(report).toContain('120 frames sampled, 3 recognised');
    expect(report).toContain('4 sightings on record: 2 accepted, 1 rejected, 1 undecided');
    expect(report).toContain('issued as review-ready while the database still held undecided sightings');
    expect(report).toContain('Supersedes:</strong> receipt 99999999-2222-3333-4444-555555555555');
    expect(report).toContain('Verify this page in FCM');
  });

  it('says plainly when the recording fails integrity and when no receipt was issued', () => {
    const base = { title: 'CCTV evidence report', generatedAt: 'now', place: 'Gate', jobId: 'job-1', evidenceId: 'ev-1', personCount: 0, vehicleCount: 0, frameCount: 0, observations: [] };
    const mismatch = buildCCTVPrintableReport({ ...base, receipt: { reportId: 'r', issuedAt: 't', sha256: 'h', provenance: { evidence: { integrity_state: 'mismatch' }, review_consistency: 'draft' } } });
    expect(mismatch).toContain('INTEGRITY MISMATCH');
    expect(mismatch).toContain('Not locked');
    expect(mismatch).toContain('Draft: review was not claimed complete.');
    expect(buildCCTVPrintableReport(base)).not.toContain('Report receipt');
  });
});
