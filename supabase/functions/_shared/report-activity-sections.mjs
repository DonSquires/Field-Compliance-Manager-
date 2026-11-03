// Client month-end activity report sections for the report-pack PDF and email.
// The data comes from public.build_agreement_activity_report (frozen into
// monthly_report_packs.data.activityReport and .activity_lines when the pack is
// generated). These helpers only lay the frozen snapshot out; they never query,
// recount or invent values. The snapshot already withholds travel,
// administration and shift markers, so everything here is what happened at the
// client's locations, written for the client: no hours, distances, staff,
// costs, system or import detail.

/**
 * @typedef {{ b: string, p: string }} ReportPhotoRef
 * @typedef {{ label: string, width: number, align?: 'left' | 'right' }} ReportTableColumn
 * @typedef {{ kind: 'section', title: string }} ReportSectionBlock
 * @typedef {{ kind: 'subsection', title: string, detail?: string }} ReportSubsectionBlock
 * @typedef {{ kind: 'text', text: string, size?: number, bold?: boolean, muted?: boolean }} ReportTextBlock
 * @typedef {{ kind: 'table', columns: ReportTableColumn[], rows: string[][], size?: number }} ReportTableBlock
 * @typedef {{ label: string, value: string }} ReportMetric
 * @typedef {{ kind: 'metrics', items: ReportMetric[] }} ReportMetricsBlock
 * @typedef {{ label?: string, text: string }} ReportEntryLine
 * @typedef {{ kind: 'entry', when: string, tags: string[], title: string, lines: ReportEntryLine[], photos: ReportPhotoRef[], photoCount: number, tone: 'incident' | 'default' }} ReportEntryBlock
 * @typedef {{ kind: 'charts', charts: Array<{ title: string, items: Array<{ label: string, value: number }> }> }} ReportChartsBlock
 * @typedef {{ ref: ReportPhotoRef, caption: string }} ReportGalleryPhoto
 * @typedef {{ kind: 'gallery', photos: ReportGalleryPhoto[] }} ReportGalleryBlock
 * @typedef {{ text: string, bold: boolean }} ReportTextRun
 * @typedef {{ kind: 'rich', runs: ReportTextRun[], style: 'heading' | 'bullet' | 'paragraph' }} ReportRichBlock
 * @typedef {ReportSectionBlock | ReportSubsectionBlock | ReportTextBlock | ReportTableBlock | ReportMetricsBlock | ReportChartsBlock | ReportGalleryBlock | ReportEntryBlock | ReportRichBlock} ReportBlock
 */

export const ACTIVITY_REPORT_VERSION = 2;
export const NO_PLACE_LABEL = 'Not location-specific';
export const SUMMARY_PHOTO_LIMIT = 6;
// Photos named for NZTA are privileged and never go into a client report.
export const PRIVILEGED_PHOTO = /nzta/i;

/** Incident types a reviewer can confirm (public.report_incident_triage). */
export const INCIDENT_TYPE_LABELS = {
  theft: 'Theft',
  trespass: 'Trespass',
  perimeter_compromise: 'Perimeter compromise',
  vandalism: 'Vandalism or damage',
  surveillance_tampering: 'Surveillance tampering',
  hardware_failure: 'Lock or hardware failure',
  illegal_hunting: 'Illegal hunting or firearms',
  dumping: 'Dumping',
  fire: 'Fire',
  safety_hazard: 'Safety hazard',
  other: 'Other incident',
};

/** @param {unknown} code */
export function incidentTypeLabel(code) {
  const key = typeof code === 'string' ? code.trim() : '';
  return /** @type {Record<string, string>} */ (INCIDENT_TYPE_LABELS)[key] || (key ? humaniseCode(key) : 'Incident');
}

const LINE_KEY_IGNORED = new Set(['pr', 'ph', 'vid', 'tri', 'key']);

/**
 * Content key of one frozen activity line. Snapshot lines carry no record id,
 * so triage decisions are keyed on every content field the client sees and Bob
 * assesses. Photo and video counts and refs are left out because media can
 * arrive after a pack is generated. Must match activityLineKey in
 * apps/web/src/lib/reportActivity.ts.
 * @param {Record<string, unknown>} line
 */
export function activityLineKey(line) {
  const source = JSON.stringify(Object.keys(line)
    .filter((field) => !LINE_KEY_IGNORED.has(field))
    .sort()
    .map((field) => [field, typeof line[field] === 'string' ? /** @type {string} */ (line[field]).trim() : line[field] ?? null])
    .filter(([, value]) => value !== '' && value !== null));
  // cyrb53 (public domain): a fast 53-bit string hash.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `v1:${hash.toString(16).padStart(14, '0')}`;
}

/**
 * Marks the lines a reviewer confirmed as incidents (line.tri = type code) so
 * the client report lists them under Incidents and Investigations.
 * @param {unknown} activityLines
 * @param {Array<{ line_key?: unknown, decision?: unknown, incident_type?: unknown }>} triage
 */
export function applyIncidentTriage(activityLines, triage) {
  const document = obj(activityLines);
  if (!document || !Array.isArray(document.lines) || !Array.isArray(triage) || !triage.length) return activityLines;
  /** @type {Map<string, string>} */
  const confirmed = new Map();
  for (const row of triage) {
    if (row?.decision === 'incident' && typeof row.line_key === 'string') confirmed.set(row.line_key, text(row.incident_type) || 'other');
  }
  if (!confirmed.size) return activityLines;
  return {
    ...document,
    lines: document.lines.map((line) => {
      const value = obj(line);
      if (!value || text(value.k) === 'incident') return line;
      const type = confirmed.get(activityLineKey(value));
      return type ? { ...value, tri: type } : line;
    }),
  };
}

/** A recorded incident or an entry confirmed as one on review. @param {Record<string, unknown>} line */
export function isIncidentLine(line) {
  return text(line.k) === 'incident' || Boolean(text(line.tri));
}

/** @param {string} value @returns {ReportTextRun[]} */
function markupRuns(value) {
  /** @type {ReportTextRun[]} */
  const runs = [];
  value.split('**').forEach((part, index) => {
    const cleaned = part.replace(/__|`/g, '');
    if (cleaned) runs.push({ text: cleaned, bold: index % 2 === 1 });
  });
  return runs.length ? runs : [{ text: value.replace(/\*\*|__|`/g, ''), bold: false }];
}

/**
 * The reviewer's summary as headings, bullets and paragraphs. Supports the
 * small markdown subset Bob drafts in: **bold**, "# heading" or a line that is
 * wholly bold, and "* ", "- " or "• " bullets. Plain prose stays paragraphs.
 * @param {unknown} value
 * @returns {Array<{ style: 'heading' | 'bullet' | 'paragraph', runs: ReportTextRun[] }>}
 */
export function summaryMarkup(value) {
  const source = typeof value === 'string' ? value.replace(/\r\n/g, '\n') : '';
  /** @type {Array<{ style: 'heading' | 'bullet' | 'paragraph', runs: ReportTextRun[] }>} */
  const items = [];
  /** @type {string[]} */
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) items.push({ style: 'paragraph', runs: markupRuns(paragraph.join(' ')) });
    paragraph = [];
  };
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (heading || /^\*\*[^*]+\*\*:?$/.test(line)) {
      flush();
      items.push({ style: 'heading', runs: [{ text: (heading ? heading[1] : line).replace(/\*\*|__|`/g, '').trim(), bold: true }] });
    } else if (bullet) {
      flush();
      items.push({ style: 'bullet', runs: markupRuns(bullet[1]) });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return items;
}

/**
 * The executive summary without Bob's own "Executive Summary: ..." title, for
 * surfaces that already show an Executive Summary heading.
 * @param {unknown} value
 */
export function executiveSummaryMarkup(value) {
  const items = summaryMarkup(value);
  if (items[0]?.style === 'heading' && /^executive summary\b/i.test(items[0].runs.map((run) => run.text).join(''))) items.shift();
  return items;
}

/**
 * Logged entries a reviewer confirmed as incidents, after applyIncidentTriage.
 * @param {unknown} activityLines
 */
export function confirmedIncidentCount(activityLines) {
  return readActivityLines(activityLines).lines.filter((line) => text(line.k) !== 'incident' && Boolean(text(line.tri))).length;
}

const numberFormats = new Map();

/** @param {number} value @param {number} [digits] */
function fmt(value, digits = 0) {
  if (!numberFormats.has(digits)) numberFormats.set(digits, new Intl.NumberFormat('en-NZ', { maximumFractionDigits: digits }));
  return numberFormats.get(digits).format(value);
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function rows(value) {
  return Array.isArray(value) ? value.map(obj).filter((item) => item !== null) : [];
}

/** @param {unknown} value */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** @param {string} value */
const normText = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** @param {string} left @param {string} right */
function sameText(left, right) {
  return Boolean(left && right && normText(left) === normText(right));
}

/**
 * A short imported label such as "Pest" or "Patrol" says nothing a category
 * of "Pest control" or "Patrols and site checks" does not already say.
 * @param {string} label @param {string} other
 */
function repeats(label, other) {
  return Boolean(label && other && normText(other).startsWith(normText(label)));
}

/** @param {string} code */
export function humaniseCode(code) {
  const value = code.replaceAll('_', ' ').trim();
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

const FIXED_LABELS = {
  incidentType: { cctv_bookmark: 'CCTV review' },
  severity: { low: 'Low', standard: 'Standard', high: 'High', critical: 'Critical' },
  incidentStatus: { open: 'Open', in_review: 'Under review', resolved: 'Resolved', escalated: 'Escalated' },
  investigationStatus: { open: 'Open', active: 'Active', awaiting_evidence: 'Awaiting evidence', awaiting_review: 'Awaiting review', referred: 'Referred', court: 'Before the court', resolved: 'Resolved', closed: 'Closed' },
  workOrderStatus: { approved: 'Scheduled', in_progress: 'In progress', completed: 'Completed' },
  module: { unknown: 'General' },
};

/**
 * Returns the frozen activity report from a monthly pack's data, or null for
 * packs generated before the client activity report existed.
 * @param {unknown} data
 */
export function readActivityReport(data) {
  const report = obj(obj(data)?.activityReport);
  if (!report || report.version !== ACTIVITY_REPORT_VERSION || !obj(report.totals)) return null;
  return report;
}

/**
 * Itemised lines that belong to the same snapshot version, or [] when absent.
 * @param {unknown} activityLines
 */
export function readActivityLines(activityLines) {
  const document = obj(activityLines);
  return {
    lines: document?.version === ACTIVITY_REPORT_VERSION ? rows(document.lines) : [],
    notItemised: document?.version === ACTIVITY_REPORT_VERSION ? num(document.notItemised) : 0,
  };
}

/** @param {Record<string, unknown>} report */
export function labeller(report) {
  const labels = obj(report.labels) ?? {};
  /** @param {string} dim @param {unknown} code */
  return (dim, code) => {
    const key = text(code);
    if (!key) return '';
    const label = text(obj(labels[dim])?.[key]) || text(obj(FIXED_LABELS[dim])?.[key]);
    return label || humaniseCode(key);
  };
}

/** @param {string} title @returns {ReportSectionBlock} */
const section = (title) => ({ kind: 'section', title });
/** @param {string} value @param {number} [size] @param {boolean} [muted] @returns {ReportTextBlock} */
const note = (value, size, muted) => ({ kind: 'text', text: value, size, muted });

/**
 * @param {Array<[string, number] | [string, number, 'right']>} columns
 * @param {string[][]} body
 * @param {number} [size]
 * @returns {ReportTableBlock}
 */
function table(columns, body, size) {
  return { kind: 'table', columns: columns.map(([label, width, align]) => ({ label, width, align: align ?? 'left' })), rows: body, size };
}

/**
 * "1 entry" / "3 entries": client-facing copy must not read "1 entries".
 * @param {unknown} value @param {string} one @param {string} many
 */
const counted = (value, one, many) => `${fmt(num(value))} ${num(value) === 1 ? one : many}`;
/** @param {unknown} value */
const isAre = (value) => (num(value) === 1 ? 'is' : 'are');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-14" -> "Wed 14 Oct 2026" (the snapshot dates are already New Zealand dates). @param {string} value */
export function reportDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${DAYS[day.getUTCDay()]} ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** @param {string[]} dates ISO dates in order */
function dayList(dates) {
  /** @type {Map<string, number[]>} */
  const byMonth = new Map();
  for (const value of dates) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) continue;
    const key = `${match[1]}-${match[2]}`;
    const days = byMonth.get(key) ?? [];
    if (!days.includes(Number(match[3]))) days.push(Number(match[3]));
    byMonth.set(key, days);
  }
  return [...byMonth.entries()].map(([key, days]) => `${days.join(', ')} ${MONTHS[Number(key.slice(5)) - 1]}`).join('; ');
}

/** @param {Record<string, unknown>} line @param {ReturnType<typeof labeller>} label */
function materialsText(line, label) {
  return rows(line.m).map((item) => {
    const quantity = typeof item.q === 'number' ? ` × ${fmt(item.q, 2)}` : '';
    const calibre = text(item.cal) && text(item.cal) !== 'unspecified' ? ` ${text(item.cal)}` : '';
    return `${label('material', item.t)}${calibre}${quantity}`;
  }).join(', ');
}

/** @param {Record<string, unknown>} line */
function photoRefs(line) {
  return rows(line.pr)
    .map((ref) => ({ b: text(ref.b), p: text(ref.p) }))
    .filter((ref) => ref.b && ref.p && !/^https?:/i.test(ref.p) && !PRIVILEGED_PHOTO.test(ref.p));
}

/**
 * A patrol or site check with nothing written, no photo and nothing used.
 * The site log counts these per location instead of listing each one.
 * @param {Record<string, unknown>} line
 */
export function isRoutineLine(line) {
  return text(line.k) === 'event' && text(line.c) === 'patrol_visit'
    && !text(line.n) && !text(line.ac) && num(line.ph) === 0 && rows(line.m).length === 0;
}

/**
 * One client-facing entry: when, what kind, what was seen or done, what was
 * done about it, and the photos taken.
 * @param {Record<string, unknown>} line
 * @param {ReturnType<typeof labeller>} label
 * @returns {ReportEntryBlock}
 */
function entryFromLine(line, label) {
  const kind = text(line.k);
  const noteText = text(line.n);
  const action = text(line.ac);
  const issue = text(line.ti);
  /** @type {string[]} */
  const tags = [];
  /** @type {ReportEntryLine[]} */
  const lines = [];
  let title = '';
  if (kind === 'incident') {
    title = label('incidentType', line.it) || 'Incident';
    tags.push(`${label('severity', line.sev || 'standard')} severity`, label('incidentStatus', line.st || 'open'));
    if (noteText) lines.push({ text: noteText });
    if (text(line.inv)) lines.push({ label: 'Investigation', text: [text(line.inv), label('investigationStatus', line.ivs)].filter(Boolean).join(' · ') });
    if (num(line.vid) > 0) lines.push({ label: 'Video', text: `${counted(line.vid, 'video clip', 'video clips')} held on file` });
  } else {
    const category = label('category', line.c);
    tags.push(category);
    if (kind === 'observation') tags.push(`${label('module', line.mo || 'unknown')} observation`);
    if (kind === 'work_order') {
      title = issue;
      if (text(line.ws)) tags.push(label('workOrderStatus', line.ws));
    } else {
      title = [label('activity', line.a), label('subject', line.s), label('species', line.sp), label('equipment', line.eq)]
        .filter((value, index, all) => value && all.indexOf(value) === index && !sameText(value, category))
        .join(' · ');
      if (issue && !sameText(issue, noteText) && !repeats(issue, category) && !repeats(issue, title)) tags.push(issue);
    }
    if (noteText && !sameText(noteText, title)) lines.push({ text: noteText });
    const materials = materialsText(line, label);
    if (materials) lines.push({ label: 'Used', text: materials });
    if (action && !sameText(action, noteText)) lines.push({ label: kind === 'work_order' ? 'Completion' : 'Action taken', text: action });
  }
  if (text(line.j)) tags.push(`Ref ${text(line.j)}`);
  return {
    kind: 'entry',
    when: [reportDate(text(line.d)), text(line.t)].filter(Boolean).join(' · '),
    tags: tags.filter(Boolean),
    title,
    lines,
    photos: photoRefs(line),
    photoCount: num(line.ph),
    tone: kind === 'incident' ? 'incident' : 'default',
  };
}

/**
 * Outside the site log an entry is not under its location heading, so the
 * location leads its tags.
 * @param {Record<string, unknown>} line
 * @param {ReturnType<typeof labeller>} label
 * @returns {ReportEntryBlock}
 */
function entryWithPlace(line, label) {
  const entry = entryFromLine(line, label);
  if (text(line.k) !== 'incident' && text(line.tri)) {
    return {
      ...entry,
      title: incidentTypeLabel(line.tri),
      tags: [text(line.p) || NO_PLACE_LABEL, 'Confirmed on review', ...entry.tags],
      lines: [...(entry.title ? [{ label: 'Recorded as', text: entry.title }] : []), ...entry.lines],
      tone: 'incident',
    };
  }
  return { ...entry, tags: [text(line.p) || NO_PLACE_LABEL, ...entry.tags] };
}

/** @param {Record<string, unknown>} report */
function speciesCulls(report) {
  return rows(obj(report.pestControl)?.bySpecies).reduce((sum, row) => sum + num(row.culls), 0);
}

function summaryChart(title, source, itemLabel, itemValue) {
  const items = source.map((row) => ({ label: itemLabel(row), value: num(itemValue(row)) }))
    .filter((item) => item.label && item.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 5);
  return items.length ? { title, items } : null;
}

/**
 * An entry worth calling out to the client: an observation, a CCTV activation
 * or anything with a photo. Incidents have their own section and routine
 * patrols are only counted.
 * @param {Record<string, unknown>} line
 */
export function isNotableLine(line) {
  if (isIncidentLine(line) || isRoutineLine(line)) return false;
  return text(line.k) === 'observation' || text(line.c) === 'camera_activation' || num(line.ph) > 0;
}

/** Incidents first, then CCTV activations, observations and other photographed work. @param {Record<string, unknown>} line */
function noteRank(line) {
  if (isIncidentLine(line)) return 0;
  if (text(line.c) === 'camera_activation') return 1;
  return text(line.k) === 'observation' ? 2 : 3;
}

/** @param {string} value "2026-10-14" -> "14 Oct" */
function shortDate(value) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])} ${MONTHS[Number(match[1]) - 1]}` : value;
}

/**
 * Up to SUMMARY_PHOTO_LIMIT photos for the summary: one per entry in order of
 * importance before any entry gets a second.
 * @param {Record<string, unknown>[]} lines
 * @param {ReturnType<typeof labeller>} label
 * @returns {ReportGalleryPhoto[]}
 */
function summaryPhotos(lines, label) {
  const ranked = lines
    .filter((line) => isIncidentLine(line) || isNotableLine(line))
    .map((line, index) => ({ line, index, refs: photoRefs(line) }))
    .filter((item) => item.refs.length)
    .sort((left, right) => noteRank(left.line) - noteRank(right.line) || left.index - right.index);
  /** @type {ReportGalleryPhoto[]} */
  const picks = [];
  const seen = new Set();
  for (let round = 0; picks.length < SUMMARY_PHOTO_LIMIT; round += 1) {
    if (!ranked.some((item) => item.refs.length > round)) break;
    for (const { line, refs } of ranked) {
      const ref = refs[round];
      if (!ref || seen.has(`${ref.b}/${ref.p}`) || picks.length >= SUMMARY_PHOTO_LIMIT) continue;
      seen.add(`${ref.b}/${ref.p}`);
      const what = text(line.k) === 'incident' ? label('incidentType', line.it) || 'Incident'
        : text(line.tri) ? incidentTypeLabel(line.tri) : label('category', line.c);
      picks.push({ ref, caption: [shortDate(text(line.d)), text(line.p) || NO_PLACE_LABEL, what].filter(Boolean).join(' · ') });
    }
  }
  return picks;
}

/** Paragraphs of reviewer text, split on blank lines. @param {string} value */
export function textParagraphs(value) {
  return value.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

/**
 * The reviewer's executive summary and highlights as headings, bullets and
 * paragraphs. Nothing is shown when the reviewer has written neither: the
 * figures already have their own At a Glance section.
 * @param {unknown} summary
 * @param {unknown} highlights
 * @returns {ReportBlock[]}
 */
export function executiveSummaryBlocks(summary, highlights) {
  const items = executiveSummaryMarkup(summary);
  const all = [...items, ...summaryMarkup(highlights)];
  if (!all.length) return [];
  return [section('Executive Summary'), ...all.map((item) => /** @type {ReportRichBlock} */ ({ kind: 'rich', runs: item.runs, style: item.style }))];
}

/**
 * Client summary sections for a monthly pack, in reading order: the
 * reviewer's executive summary (omitted when none is written) with a few
 * photos, at a glance with its charts, then the activity tables with incidents
 * and investigations itemised, including logged entries a reviewer confirmed
 * as incidents (line.tri, see applyIncidentTriage). Returns null when the pack
 * has no client activity report so the caller keeps its legacy layout.
 * @param {unknown} data
 * @param {unknown} [activityLines]
 * @param {{ summary?: unknown, highlights?: unknown }} [options] the reviewer's executive summary and highlights, shown first
 * @returns {ReportBlock[] | null}
 */
export function monthlyActivityBlocks(data, activityLines, options = {}) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const totals = obj(report.totals) ?? {};
  const pest = obj(report.pestControl) ?? {};
  const { lines } = readActivityLines(activityLines);
  /** @type {ReportBlock[]} */
  const blocks = [];

  blocks.push(...executiveSummaryBlocks(options?.summary, options?.highlights));
  const gallery = summaryPhotos(lines, label);
  if (gallery.length) {
    if (!blocks.length) blocks.push(section('Selected Photos'));
    blocks.push({ kind: 'gallery', photos: gallery });
    blocks.push(note('Selected photos from the period. Each is shown again with its entry.', 8, true));
  }

  const confirmedLines = lines.filter((line) => text(line.k) !== 'incident' && text(line.tri));
  blocks.push(section('At a Glance'));
  const metrics = [
    { label: 'Locations with activity', value: fmt(num(totals.places)) },
    { label: 'Entries recorded', value: fmt(num(totals.entries)) },
    { label: 'Incidents', value: fmt(num(totals.incidents) + confirmedLines.length) },
    { label: 'Observations', value: fmt(num(totals.observations)) },
    { label: 'Patrols', value: fmt(num(totals.patrolVisits)) },
    { label: 'CCTV activity', value: fmt(num(totals.cameraActivations)) },
    { label: 'Photos', value: fmt(num(totals.photos)) },
    { label: 'Pest culls recorded', value: fmt(speciesCulls(report)) },
  ];
  const hunters = obj(report.hunterReturns);
  if (hunters) metrics.push({ label: 'Hunter-reported kills', value: fmt(num(hunters.animals)) });
  blocks.push({ kind: 'metrics', items: metrics });
  if (text(report.basis)) blocks.push(note(text(report.basis), 8.5, true));

  const categories = rows(report.categories);
  const activityChart = summaryChart('Activity type highlights', categories,
    (row) => label('category', text(row.code)), (row) => row.entries);
  const camera = categories.find((row) => text(row.code) === 'camera_activation');
  if (activityChart && num(camera?.entries) > 0 && !activityChart.items.some((item) => item.label === label('category', 'camera_activation'))) {
    activityChart.items.push({ label: label('category', 'camera_activation'), value: num(camera.entries) });
  }
  const charts = [
    activityChart,
    summaryChart('Top locations', rows(report.byPlace),
      (row) => text(row.place) || NO_PLACE_LABEL, (row) => row.entries),
    summaryChart('Pest culls by species', rows(pest.bySpecies),
      (row) => label('species', text(row.code)), (row) => row.culls),
    summaryChart('Hunter animals by species', rows(hunters?.bySpecies),
      (row) => text(row.species), (row) => row.animals),
  ].filter(Boolean);
  if (charts.length) {
    blocks.push({ kind: 'charts', charts });
    blocks.push(note('Charts highlight the highest recorded counts; complete figures remain in the tables below.', 8, true));
  }

  blocks.push(section('Activity Overview'));
  if (categories.length) {
    blocks.push(table(
      [['Type of activity', 307], ['Entries', 90, 'right'], ['Photos', 90, 'right']],
      categories.map((row) => [label('category', row.code), fmt(num(row.entries)), fmt(num(row.photos))]),
    ));
  } else {
    blocks.push(note('Nothing was recorded at your locations during the period.'));
  }

  const incidents = obj(report.incidents) ?? {};
  blocks.push(section('Incidents and Investigations'));
  if (num(incidents.total) > 0 || confirmedLines.length) {
    const parts = [];
    if (num(incidents.total) > 0) parts.push(counted(incidents.total, 'incident was', 'incidents were') + ' recorded at your locations');
    if (confirmedLines.length) parts.push(`${counted(confirmedLines.length, 'further logged entry was', 'further logged entries were')} confirmed as ${confirmedLines.length === 1 ? 'an incident' : 'incidents'} on review`);
    if (num(incidents.investigations) > 0) parts.push(`${counted(incidents.investigations, 'investigation is', 'investigations are')} linked`);
    if (num(incidents.withMedia) > 0) parts.push(`${fmt(num(incidents.withMedia))} with photo or video evidence`);
    blocks.push(note(`${parts.join('; ')}.`));
    const breakdown = (key, dim) => rows(incidents[key]).map((row) => `${label(dim, row.code)} ${fmt(num(row.entries))}`).join(' · ');
    const severity = breakdown('bySeverity', 'severity');
    const status = breakdown('byStatus', 'incidentStatus');
    if (severity || status) blocks.push(note([severity && `Severity: ${severity}`, status && `Status: ${status}`].filter(Boolean).join('   |   '), 9, true));
    const incidentLines = lines.filter(isIncidentLine);
    for (const line of incidentLines) blocks.push(entryWithPlace(line, label));
    const unlisted = num(incidents.total) - (incidentLines.length - confirmedLines.length);
    if (unlisted > 0) blocks.push(note(`${counted(unlisted, 'further incident is', 'further incidents are')} held on file.`, 9, true));
  } else {
    blocks.push(note('No incidents were recorded at your locations during the period.'));
  }

  const places = rows(report.byPlace);
  if (places.length) {
    blocks.push(section('Activity by Location'));
    blocks.push(table(
      [['Location', 170], ['Entries', 60, 'right'], ['Photos', 60, 'right'], ['Main activity', 197]],
      places.map((row) => {
        const mix = Object.entries(obj(row.categories) ?? {})
          .filter(([, count]) => num(count) > 0)
          .sort(([leftCode, left], [rightCode, right]) => num(right) - num(left) || leftCode.localeCompare(rightCode))
          .slice(0, 3)
          .map(([code, count]) => `${label('category', code)} ${fmt(num(count))}`)
          .join(', ');
        return [text(row.place) || NO_PLACE_LABEL, fmt(num(row.entries)), fmt(num(row.photos)), mix];
      }),
    ));
  }

  blocks.push(section('Pest Control'));
  if (num(pest.entries) > 0) {
    blocks.push(note(`${counted(pest.entries, 'pest-control entry was', 'pest-control entries were')} recorded. Species figures count recorded entries, not population estimates.`));
    const species = rows(pest.bySpecies);
    if (species.length) {
      blocks.push(table(
        [['Species', 187], ['Culls', 75, 'right'], ['Sightings', 75, 'right'], ['Other', 75, 'right'], ['Total', 75, 'right']],
        species.map((row) => [label('species', row.code), fmt(num(row.culls)), fmt(num(row.sightings)), fmt(num(row.other)), fmt(num(row.total))]),
      ));
    }
    const activities = rows(pest.byActivity);
    if (activities.length) {
      blocks.push(table(
        [['Pest-control work', 387], ['Entries', 100, 'right']],
        activities.map((row) => [label('activity', row.code), fmt(num(row.entries))]),
      ));
    }
    const equipment = rows(pest.byEquipment);
    if (equipment.length) {
      blocks.push(table(
        [['Traps, bait stations and equipment', 387], ['Entries', 100, 'right']],
        equipment.map((row) => [label('equipment', row.code), fmt(num(row.entries))]),
      ));
    }
    const ammunition = rows(pest.ammunition);
    if (ammunition.length) {
      blocks.push(table(
        [['Ammunition calibre', 287], ['Entries', 100, 'right'], ['Rounds recorded', 100, 'right']],
        ammunition.map((row) => [
          text(row.calibre) && text(row.calibre) !== 'unspecified' ? text(row.calibre) : 'Calibre not recorded',
          fmt(num(row.entries)),
          typeof row.rounds === 'number' ? fmt(row.rounds) : 'Not recorded',
        ]),
      ));
    }
  } else {
    blocks.push(note('No pest-control work was recorded at your locations during the period.'));
  }

  if (hunters) {
    blocks.push(section('Hunter Kill Returns'));
    if (num(hunters.returns) > 0) {
      blocks.push(note(`${counted(hunters.returns, 'hunter return was', 'hunter returns were')} submitted for hunts in the period: ${fmt(num(hunters.killReturns))} with kills and ${fmt(num(hunters.nilReturns))} nil. ${counted(hunters.animals, 'animal was', 'animals were')} reported. Figures are as reported by permit holders.`));
      const species = rows(hunters.bySpecies);
      if (species.length) {
        blocks.push(table(
          [['Species', 287], ['Animals reported', 100, 'right'], ['Returns', 100, 'right']],
          species.map((row) => [text(row.species), fmt(num(row.animals)), fmt(num(row.returns))]),
        ));
      }
      const areas = rows(hunters.byArea);
      if (areas.length) {
        blocks.push(table(
          [['Hunting area', 187], ['Returns', 75, 'right'], ['With kills', 75, 'right'], ['Nil', 75, 'right'], ['Animals', 75, 'right']],
          areas.map((row) => [text(row.area), fmt(num(row.returns)), fmt(num(row.kill)), fmt(num(row.nil)), fmt(num(row.animals))]),
        ));
      }
    } else {
      blocks.push(note('No hunter kill or nil returns were submitted for hunts in the period.'));
    }
  }

  for (const [key, title, empty] of /** @type {const} */ ([
    ['maintenance', 'Maintenance and Repairs', 'No maintenance or repair work was recorded during the period.'],
    ['manufacture', 'Manufacture and Fabrication', 'No manufacture or fabrication work was recorded during the period.'],
  ])) {
    const work = obj(report[key]) ?? {};
    const orders = obj(work.workOrders) ?? {};
    blocks.push(section(title));
    if (num(work.entries) > 0) {
      const jobs = num(orders.completed) + num(orders.open) > 0
        ? ` Workshop jobs: ${fmt(num(orders.completed))} completed, ${fmt(num(orders.open))} scheduled or in progress.`
        : '';
      blocks.push(note(`${counted(work.entries, 'entry was', 'entries were')} recorded.${jobs}`));
      const subjects = rows(work.bySubject);
      if (subjects.length) {
        blocks.push(table(
          [['Item worked on', 387], ['Entries', 100, 'right']],
          subjects.map((row) => [label('subject', row.code) || 'Not specified', fmt(num(row.entries))]),
        ));
      }
    } else {
      blocks.push(note(empty));
    }
  }

  const observations = obj(report.observations) ?? {};
  blocks.push(section('Observations'));
  const modules = rows(observations.byModule);
  if (modules.length) {
    blocks.push(note(`${counted(observations.total, 'observation was', 'observations were')} recorded; ${fmt(num(observations.withPhoto))} with photos.`));
    blocks.push(table(
      [['Observation type', 187], ['Observations', 100, 'right'], ['With photo', 100, 'right'], ['Photos', 100, 'right']],
      modules.map((row) => [label('module', row.module), fmt(num(row.entries)), fmt(num(row.withPhoto)), fmt(num(row.photos))]),
    ));
  } else {
    blocks.push(note('No observations were recorded at your locations during the period.'));
  }
  return blocks;
}

/**
 * The site log: every reported entry grouped by location in date order, with
 * its comments, action taken and photos. Routine patrols with nothing to
 * report are counted per location rather than listed. Incidents are described
 * in their own section, so they are not repeated here.
 * @param {unknown} data
 * @param {unknown} activityLines
 * @returns {ReportBlock[]}
 */
export function siteLogBlocks(data, activityLines) {
  const report = readActivityReport(data);
  if (!report) return [];
  const label = labeller(report);
  const { lines, notItemised } = readActivityLines(activityLines);
  /** @type {ReportBlock[]} */
  const blocks = [section('Site Log')];
  if (!lines.length) {
    blocks.push(note(num(obj(report.totals)?.entries) > 0
      ? 'The itemised site log is not available for this report.'
      : 'Nothing was recorded at your locations during the period.'));
    return blocks;
  }
  blocks.push(note('What happened at each location, in date order (New Zealand time).', 9, true));
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byPlace = new Map();
  for (const line of lines) {
    if (isIncidentLine(line)) continue;
    const place = text(line.p) || NO_PLACE_LABEL;
    byPlace.set(place, [...(byPlace.get(place) ?? []), line]);
  }
  const placeNames = [...byPlace.keys()].sort((left, right) => (left === NO_PLACE_LABEL ? 1 : 0) - (right === NO_PLACE_LABEL ? 1 : 0) || left.localeCompare(right));
  for (const place of placeNames) {
    const placeLines = byPlace.get(place) ?? [];
    const routine = placeLines.filter(isRoutineLine);
    blocks.push({ kind: 'subsection', title: place, detail: counted(placeLines.length, 'entry', 'entries') });
    for (const line of placeLines) if (!isRoutineLine(line)) blocks.push(entryFromLine(line, label));
    if (routine.length) {
      blocks.push(note(`${counted(routine.length, 'routine patrol', 'routine patrols')} with nothing further to report (${dayList(routine.map((line) => text(line.d)))}).`, 9, true));
    }
  }
  if (notItemised > 0) {
    blocks.push(note(`A further ${counted(notItemised, 'entry', 'entries')} from this period ${isAre(notItemised)} included in the totals above and held on file.`, 9, true));
  }
  return blocks;
}

/**
 * Short email summary: one headline sentence plus entries by type of activity.
 * @param {unknown} data
 * @param {{ confirmedIncidents?: number }} [options] logged entries a reviewer confirmed as incidents, counted with recorded incidents
 * @returns {{ headline: string, categories: string[][] } | null}
 */
export function activityEmailSummary(data, options = {}) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const reported = obj(report.totals) ?? {};
  const totals = { ...reported, incidents: num(reported.incidents) + Math.max(0, Math.trunc(num(options.confirmedIncidents))) };
  const hunters = obj(report.hunterReturns);
  const hunterSentence = hunters && num(hunters.returns) > 0
    ? ` Permit holders submitted ${counted(hunters.returns, 'hunter return', 'hunter returns')} reporting ${counted(hunters.animals, 'animal', 'animals')}.`
    : '';
  return {
    headline: `${counted(totals.entries, 'entry', 'entries')} recorded across ${counted(totals.places, 'location', 'locations')}, including ${counted(totals.incidents, 'incident', 'incidents')}, ${counted(totals.observations, 'observation', 'observations')} and ${counted(totals.photos, 'photo', 'photos')}.${hunterSentence}`,
    categories: rows(report.categories).map((row) => [label('category', row.code), fmt(num(row.entries))]),
  };
}
