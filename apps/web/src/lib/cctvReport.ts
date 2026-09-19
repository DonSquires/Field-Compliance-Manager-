export type CCTVPrintableReportInput = {
  title: string;
  reportStatus?: 'draft' | 'review_ready';
  generatedAt: string;
  place: string;
  jobId: string;
  evidenceId: string;
  batchId?: string | null;
  clipCount?: number | null;
  loadedClipCount?: number | null;
  batchComplete?: boolean;
  personCount: number;
  vehicleCount: number;
  animalCount?: number;
  frameCount: number;
  assessment?: {
    what: string;
    when: string;
    where: string;
    why: string;
    how: string;
  };
  activityGroups?: Array<{
    kind: 'person' | 'vehicle' | 'animal';
    label: string;
    authority: string;
    firstObservedAt: string;
    lastObservedAt: string;
    visitDates: string[];
    observationCount: number;
    blurb: string;
  }>;
  evidenceImages?: Array<{
    kind: 'person' | 'vehicle' | 'animal';
    src: string;
    label: string;
    timestampSeconds?: number | null;
    sha256Hash?: string | null;
    reviewState?: string | null;
  }>;
  observations: Array<{
    kind: string;
    label: string;
    confidence?: number | null;
    startSeconds?: number | null;
    endSeconds?: number | null;
    reviewState?: string | null;
  }>;
  /** The receipt the database issued for this exact payload; printed so the page can be verified later. */
  receipt?: CCTVReportReceiptProvenance | null;
};

/** Shape returned by issue_cctv_report_receipt: the hash plus the server-side provenance block. */
export type CCTVReportReceiptProvenance = {
  reportId: string;
  issuedAt: string;
  sha256: string;
  provenance: {
    evidence?: { sha256_hash?: string | null; locked_at?: string | null; is_court_ready?: boolean; integrity_state?: string | null; integrity_checked_at?: string | null; source_size_bytes?: number | null } | null;
    import?: { camera_label?: string | null; source_device_kind?: string | null; source_timezone?: string | null; place_name?: string | null; place_address?: string | null } | null;
    result?: { inference_result_id?: string | null; classification_plan?: { policy?: string | null; sampled_frames?: number | null; representative_frames?: number | null } | null } | null;
    review?: { observations_total?: number; accepted?: number; rejected?: number; unreviewed?: number; undecided?: number; legacy_decisions?: number } | null;
    review_consistency?: string | null;
    supersedes?: { receipt_id?: string | null; issued_at?: string | null; earlier_receipts?: number | null } | null;
  } | null;
};

export function receiptBlock(receipt: CCTVReportReceiptProvenance): string {
  const p = receipt.provenance ?? {};
  const evidence = p.evidence ?? {};
  const imp = p.import ?? {};
  const review = p.review ?? {};
  const plan = p.result?.classification_plan ?? null;
  const integrity = evidence.integrity_state === 'verified'
    ? `verified${evidence.integrity_checked_at ? ` ${escapeHtml(evidence.integrity_checked_at)}` : ''}`
    : evidence.integrity_state === 'mismatch' ? 'INTEGRITY MISMATCH — the stored recording no longer matches its recorded hash'
      : evidence.integrity_state === 'unanchored' ? 'measured before any hash was recorded'
        : 'not yet re-measured';
  const seal = evidence.locked_at ? `Locked ${escapeHtml(evidence.locked_at)} (court-ready; retention hold)` : 'Not locked';
  const reviewLine = typeof review.observations_total === 'number'
    ? `${review.observations_total} sighting${review.observations_total === 1 ? '' : 's'} on record: ${review.accepted ?? 0} accepted, ${review.rejected ?? 0} rejected, ${(review.unreviewed ?? 0) + (review.undecided ?? 0)} undecided${review.legacy_decisions ? `; ${review.legacy_decisions} earlier event decision${review.legacy_decisions === 1 ? '' : 's'}` : ''}`
    : 'No sightings on record';
  const consistency = p.review_consistency === 'consistent'
    ? 'The database agrees every sighting was decided before this report was issued.'
    : p.review_consistency === 'draft'
      ? 'Draft: review was not claimed complete.'
      : p.review_consistency
        ? '<strong>Warning:</strong> this report was issued as review-ready while the database still held undecided sightings. Treat its review states as provisional.'
        : '';
  const supersedes = p.supersedes?.receipt_id ? `<p><strong>Supersedes:</strong> receipt ${escapeHtml(p.supersedes.receipt_id)}${p.supersedes.issued_at ? ` issued ${escapeHtml(p.supersedes.issued_at)}` : ''}${p.supersedes.earlier_receipts && p.supersedes.earlier_receipts > 1 ? ` (${p.supersedes.earlier_receipts} earlier receipts)` : ''}</p>` : '';
  const camera = imp.camera_label ? `<p><strong>Camera:</strong> ${escapeHtml(imp.camera_label)}${imp.source_device_kind ? ` (${escapeHtml(imp.source_device_kind)})` : ''}${imp.place_name ? ` at ${escapeHtml(imp.place_name)}${imp.place_address ? `, ${escapeHtml(imp.place_address)}` : ''}` : ''}${imp.source_timezone ? ` · camera clock ${escapeHtml(imp.source_timezone)}` : ''}</p>` : '';
  const analysis = plan?.policy ? `<p><strong>Analysis:</strong> ${escapeHtml(plan.policy.replace(/_/g, ' '))}${typeof plan.sampled_frames === 'number' ? ` · ${plan.sampled_frames} frames sampled` : ''}${typeof plan.representative_frames === 'number' ? `, ${plan.representative_frames} recognised` : ''}</p>` : '';
  return `<div class="receipt"><h2>Report receipt</h2><p><strong>Receipt:</strong> <code>${escapeHtml(receipt.reportId)}</code> · issued ${escapeHtml(receipt.issuedAt)} (server time)</p><p><strong>Report hash (SHA-256):</strong> <code>${escapeHtml(receipt.sha256)}</code></p><p><strong>Source recording hash:</strong> <code>${escapeHtml(evidence.sha256_hash ?? 'not recorded')}</code>${typeof evidence.source_size_bytes === 'number' ? ` · ${evidence.source_size_bytes.toLocaleString()} bytes` : ''}</p><p><strong>Recording integrity:</strong> ${integrity} · <strong>Seal:</strong> ${seal}</p>${camera}${analysis}<p><strong>Review on record:</strong> ${reviewLine}. ${consistency}</p>${supersedes}<p class="section-note">Verify this page in FCM: CCTV review › Verify receipt, using the receipt id and report hash above. A reprint with a different hash is a different report.</p></div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] || character);
}

function observationRow(observation: CCTVPrintableReportInput['observations'][number]): string {
  const window = observation.startSeconds !== null && observation.startSeconds !== undefined
    ? `${observation.startSeconds}s - ${observation.endSeconds ?? observation.startSeconds}s`
    : 'Not available';
  const confidence = observation.confidence === null || observation.confidence === undefined
    ? 'Not reported'
    : `${Math.round(observation.confidence * 100)}%`;
  return `<tr><td>${escapeHtml(observation.kind)}</td><td>${escapeHtml(observation.label)}</td><td>${window}</td><td>${confidence}</td><td>${escapeHtml(observation.reviewState || 'Review required')}</td></tr>`;
}

function assessmentSection(assessment: NonNullable<CCTVPrintableReportInput['assessment']>): string {
  const entries = [
    ['What', assessment.what],
    ['When', assessment.when],
    ['Where', assessment.where],
    ['Why', assessment.why],
    ['How', assessment.how],
  ];
  return `<h2>Client assessment</h2><dl class="assessment">${entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><p class="boundary">No breach or identity conclusion is inferred from AI output alone. Client action requires the recorded human review state and the primary evidence.</p>`;
}

function evidenceImage(image: NonNullable<CCTVPrintableReportInput['evidenceImages']>[number]): string {
  const timestamp = image.timestampSeconds === null || image.timestampSeconds === undefined
    ? 'Time not reported'
    : `${image.timestampSeconds}s`;
  const hash = image.sha256Hash ? ` · Frame hash ${escapeHtml(image.sha256Hash)}` : '';
  return `<figure><img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.label)}"><figcaption><strong>${escapeHtml(image.label)}</strong><span>Entity: ${escapeHtml(image.kind)}</span><span>${timestamp}${hash}</span><span>Review state: ${escapeHtml(image.reviewState || 'Review required')}</span></figcaption></figure>`;
}

function activityGroupsSection(groups: NonNullable<CCTVPrintableReportInput['activityGroups']>): string {
  if (!groups.length) return '<h2>Multi-week activity groups</h2><p class="section-note">No cross-date entity groups were available.</p>';
  const rows = groups.map((group) => `<tr><td>${escapeHtml(group.kind)}</td><td>${escapeHtml(group.label)}</td><td>${escapeHtml(group.firstObservedAt)} to ${escapeHtml(group.lastObservedAt)}</td><td>${group.visitDates.length}</td><td>${group.observationCount}</td><td>${escapeHtml(group.authority)}</td><td>${escapeHtml(group.blurb)}</td></tr>`).join('');
  return `<h2>Multi-week activity groups</h2><table><thead><tr><th>Entity</th><th>Label</th><th>Observed period</th><th>Dates</th><th>Observations</th><th>Authority</th><th>Client summary</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function buildCCTVPrintableReport(input: CCTVPrintableReportInput): string {
  const batchLine = input.batchId
    ? `<p><strong>SD-card batch:</strong> ${escapeHtml(input.batchId)}${input.clipCount ? ` (${input.clipCount} clips)` : ''}${input.batchComplete === false ? ` <strong>PARTIAL: ${input.loadedClipCount ?? 0} clips loaded</strong>` : ''}</p>`
    : '';
  const receiptSection = input.receipt ? receiptBlock(input.receipt) : '';
  const rows = input.observations.length
    ? input.observations.map(observationRow).join('')
    : '<tr><td colspan="5">No consolidated observations were recorded.</td></tr>';
  const assessment = input.assessment ? assessmentSection(input.assessment) : '';
  const activityGroups = activityGroupsSection(input.activityGroups || []);
  const images = (input.evidenceImages || []).filter((image) => image.src).slice(0, 6);
  const imageSection = images.length
    ? `<h2>Evidence photographs</h2><p class="section-note">Representative frames selected from consolidated observations. Review against the primary video before client action.</p><div class="evidence-grid">${images.map(evidenceImage).join('')}</div>`
    : '<h2>Evidence photographs</h2><p class="section-note">No report-safe evidence photographs were available for this footage.</p>';

  const reportStatus = input.reportStatus || 'draft';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>
    body{font-family:Arial,sans-serif;color:#18212b;margin:32px;line-height:1.4}h1{margin:0 0 6px}h2{margin-top:28px;border-bottom:1px solid #ccd6d8;padding-bottom:6px}.meta,.section-note{color:#52646d;font-size:13px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #ccd6d8;padding:8px;text-align:left;font-size:12px}th{background:#edf3f4}.notice,.boundary{background:#fff7e7;border-left:4px solid #bd8419;padding:12px;margin-top:18px;font-size:13px}.stats{display:flex;gap:24px}.stats strong{display:block;font-size:22px}.assessment{display:grid;gap:8px}.assessment div{display:grid;grid-template-columns:72px 1fr;border-bottom:1px solid #e4eaec;padding:7px 0}.assessment dt{font-weight:700}.assessment dd{margin:0}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.evidence-grid figure{border:1px solid #ccd6d8;margin:0;break-inside:avoid}.evidence-grid img{aspect-ratio:16/9;display:block;object-fit:contain;width:100%;background:#111}.evidence-grid figcaption{display:grid;gap:3px;padding:8px;font-size:11px}.evidence-grid figcaption span{color:#52646d}.receipt{background:#f3f7f8;border:1px solid #ccd6d8;border-radius:6px;padding:12px 14px;margin-top:14px;font-size:12px}.receipt h2{margin-top:0;border:0;padding:0;font-size:15px}.receipt p{margin:4px 0}.receipt code{font-family:Menlo,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
    @page{size:A4;margin:16mm}@media print{body{margin:0}.no-print{display:none}h2{break-after:avoid;page-break-after:avoid}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.evidence-grid figure{break-inside:avoid;page-break-inside:avoid}}
  </style></head><body><h1>${escapeHtml(input.title)}</h1><p class="meta">Status: ${escapeHtml(reportStatus.replace('_', ' '))} · Generated ${escapeHtml(input.generatedAt)}</p>${receiptSection}<h2>Evidence provenance</h2><p><strong>Place:</strong> ${escapeHtml(input.place)}</p>${batchLine}<p><strong>Inference job:</strong> ${escapeHtml(input.jobId)}</p><p><strong>Evidence item:</strong> ${escapeHtml(input.evidenceId)}</p><div class="stats"><p><strong>${input.personCount}</strong> persons</p><p><strong>${input.vehicleCount}</strong> vehicles</p><p><strong>${input.frameCount}</strong> parsed frames</p></div>${assessment}${activityGroups}${imageSection}<h2>Consolidated observations</h2><table><thead><tr><th>Type</th><th>Observation</th><th>Time window</th><th>Confidence</th><th>Review state</th></tr></thead><tbody>${rows}</tbody></table><div class="notice"><strong>${reportStatus === 'draft' ? 'Draft report:' : 'Human review boundary:'}</strong> ${reportStatus === 'draft' ? 'One or more observations still require an explicit human decision. This report is not final compliance or incident evidence.' : 'AI inference is advisory. Identity, canonical placement, compliance action, and incident use require an explicit human decision recorded in the review system.'}</div></body></html>`;
}
