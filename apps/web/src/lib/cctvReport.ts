export type CCTVPrintableReportInput = {
  title: string;
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
  frameCount: number;
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

export function buildCCTVPrintableReport(input: CCTVPrintableReportInput): string {
  const batchLine = input.batchId
    ? `<p><strong>SD-card batch:</strong> ${escapeHtml(input.batchId)}${input.clipCount ? ` (${input.clipCount} clips)` : ''}${input.batchComplete === false ? ` <strong>PARTIAL: ${input.loadedClipCount ?? 0} clips loaded</strong>` : ''}</p>`
    : '';
  const rows = input.observations.length
    ? input.observations.map(observationRow).join('')
    : '<tr><td colspan="5">No consolidated observations were recorded.</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>
    body{font-family:Arial,sans-serif;color:#18212b;margin:32px;line-height:1.4}h1{margin:0 0 6px}h2{margin-top:28px;border-bottom:1px solid #ccd6d8;padding-bottom:6px}.meta{color:#52646d;font-size:13px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #ccd6d8;padding:8px;text-align:left;font-size:12px}th{background:#edf3f4}.notice{background:#fff7e7;border-left:4px solid #bd8419;padding:12px;margin-top:18px;font-size:13px}.stats{display:flex;gap:24px}.stats strong{display:block;font-size:22px}
    @media print{body{margin:16mm}.no-print{display:none}}
  </style></head><body><h1>${escapeHtml(input.title)}</h1><p class="meta">Generated ${escapeHtml(input.generatedAt)}</p><h2>Evidence provenance</h2><p><strong>Place:</strong> ${escapeHtml(input.place)}</p>${batchLine}<p><strong>Inference job:</strong> ${escapeHtml(input.jobId)}</p><p><strong>Evidence item:</strong> ${escapeHtml(input.evidenceId)}</p><div class="stats"><p><strong>${input.personCount}</strong> persons</p><p><strong>${input.vehicleCount}</strong> vehicles</p><p><strong>${input.frameCount}</strong> parsed frames</p></div><h2>Consolidated observations</h2><table><thead><tr><th>Type</th><th>Observation</th><th>Time window</th><th>Confidence</th><th>Review state</th></tr></thead><tbody>${rows}</tbody></table><div class="notice"><strong>Human review boundary:</strong> AI inference is advisory. Identity, canonical placement, compliance action, and incident use require an explicit human decision recorded in the review system.</div></body></html>`;
}
