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
};

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
    body{font-family:Arial,sans-serif;color:#18212b;margin:32px;line-height:1.4}h1{margin:0 0 6px}h2{margin-top:28px;border-bottom:1px solid #ccd6d8;padding-bottom:6px}.meta,.section-note{color:#52646d;font-size:13px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #ccd6d8;padding:8px;text-align:left;font-size:12px}th{background:#edf3f4}.notice,.boundary{background:#fff7e7;border-left:4px solid #bd8419;padding:12px;margin-top:18px;font-size:13px}.stats{display:flex;gap:24px}.stats strong{display:block;font-size:22px}.assessment{display:grid;gap:8px}.assessment div{display:grid;grid-template-columns:72px 1fr;border-bottom:1px solid #e4eaec;padding:7px 0}.assessment dt{font-weight:700}.assessment dd{margin:0}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.evidence-grid figure{border:1px solid #ccd6d8;margin:0;break-inside:avoid}.evidence-grid img{aspect-ratio:16/9;display:block;object-fit:contain;width:100%;background:#111}.evidence-grid figcaption{display:grid;gap:3px;padding:8px;font-size:11px}.evidence-grid figcaption span{color:#52646d}
    @media print{body{margin:16mm}.no-print{display:none}.evidence-grid figure{page-break-inside:avoid}}
  </style></head><body><h1>${escapeHtml(input.title)}</h1><p class="meta">Status: ${escapeHtml(reportStatus.replace('_', ' '))} · Generated ${escapeHtml(input.generatedAt)}</p><h2>Evidence provenance</h2><p><strong>Place:</strong> ${escapeHtml(input.place)}</p>${batchLine}<p><strong>Inference job:</strong> ${escapeHtml(input.jobId)}</p><p><strong>Evidence item:</strong> ${escapeHtml(input.evidenceId)}</p><div class="stats"><p><strong>${input.personCount}</strong> persons</p><p><strong>${input.vehicleCount}</strong> vehicles</p><p><strong>${input.frameCount}</strong> parsed frames</p></div>${assessment}${activityGroups}${imageSection}<h2>Consolidated observations</h2><table><thead><tr><th>Type</th><th>Observation</th><th>Time window</th><th>Confidence</th><th>Review state</th></tr></thead><tbody>${rows}</tbody></table><div class="notice"><strong>${reportStatus === 'draft' ? 'Draft report:' : 'Human review boundary:'}</strong> ${reportStatus === 'draft' ? 'One or more observations still require an explicit human decision. This report is not final compliance or incident evidence.' : 'AI inference is advisory. Identity, canonical placement, compliance action, and incident use require an explicit human decision recorded in the review system.'}</div></body></html>`;
}
