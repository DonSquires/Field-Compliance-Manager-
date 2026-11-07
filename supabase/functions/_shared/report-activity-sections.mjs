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

const LINE_KEY_IGNORED = new Set(['pr', 'ph', 'vid', 'tri', 'key', 'lk', 'pv']);
const STORED_LINE_KEY = /^v1:[0-9a-f]{14}$/;

/**
 * Content key of one frozen activity line. Snapshot lines carry no record id,
 * so triage decisions are keyed on every content field the client sees and Bob
 * assesses. Photo and video counts and refs are left out because media can
 * arrive after a pack is generated. A line reworded by Bob's privacy check
 * keeps its original key in lk. Must match activityLineKey in
 * apps/web/src/lib/reportActivity.ts.
 * @param {Record<string, unknown>} line
 */
export function activityLineKey(line) {
  if (typeof line.lk === 'string' && STORED_LINE_KEY.test(line.lk)) return line.lk;
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

/** Categories withheld from the client report (owner ruling 2026-11-05: admin records are removed). */
const WITHHELD_CATEGORIES = new Set(['administration', 'travel_admin']);

/**
 * Administration and desk entries, withheld from the client report. Packs
 * generated before the ruling still carry them, so the renderer drops them too.
 * @param {Record<string, unknown>} line
 */
export function isAdministrationLine(line) {
  // Older packs file midnight card reviews under administration; they are observations and stay in.
  return text(line.k) !== 'incident' && !text(line.tri) && WITHHELD_CATEGORIES.has(text(line.c))
    && compact(line.ti) !== 'cardreview';
}

/** @param {unknown} value */
function compact(value) {
  return text(value).toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The frozen report with administration removed from every aggregate the
 * client sees. Packs generated after the ruling carry none, so this is a no-op
 * for them; older packs lose the administration entries, categories and
 * administration-only locations consistently.
 * @param {Record<string, unknown>} report
 */
function withoutWithheld(report) {
  const categories = rows(report.categories);
  const withheld = categories.filter((row) => WITHHELD_CATEGORIES.has(text(row.code)))
    .reduce((sum, row) => sum + num(row.entries), 0);
  if (!withheld) return report;
  const totals = obj(report.totals) ?? {};
  const byPlace = rows(report.byPlace).map((row) => {
    const placeCategories = obj(row.categories) ?? {};
    const removed = Object.entries(placeCategories).filter(([code]) => WITHHELD_CATEGORIES.has(code))
      .reduce((sum, [, value]) => sum + num(value), 0);
    if (!removed) return row;
    return {
      ...row,
      entries: Math.max(0, num(row.entries) - removed),
      categories: Object.fromEntries(Object.entries(placeCategories).filter(([code]) => !WITHHELD_CATEGORIES.has(code))),
    };
  }).filter((row) => num(row.entries) > 0);
  return {
    ...report,
    totals: {
      ...totals,
      entries: Math.max(0, num(totals.entries) - withheld),
      places: Array.isArray(report.byPlace) ? byPlace.length : num(totals.places),
    },
    categories: categories.filter((row) => !WITHHELD_CATEGORIES.has(text(row.code))),
    byPlace,
  };
}

/**
 * A camera card review or other observation. Card reviews are observations
 * (owner ruling 2026-11-05) and are listed with their photos.
 * @param {Record<string, unknown>} line
 */
export function isObservationLine(line) {
  if (isIncidentLine(line)) return false;
  const category = text(line.c);
  return text(line.k) === 'observation' || category === 'camera_activation' || category === 'vehicle_observation'
    || compact(line.ti) === 'cardreview';
}

/**
 * Observations, including camera card reviews, have their own section near
 * the top of the report rather than being scattered through the site log by
 * location. Incidents keep their own section.
 */
export const REVIEW_SECTIONS = /** @type {const} */ ([
  { code: 'observation', title: 'Observations', one: 'observation was', many: 'observations were' },
]);

/**
 * The review section an entry belongs in, or '' when it stays in the site log.
 * @param {Record<string, unknown>} line
 */
export function reviewSectionCode(line) {
  return isObservationLine(line) ? 'observation' : '';
}

/**
 * Observations for At a Glance: recorded observations plus camera card reviews.
 * @param {Record<string, unknown>} totals
 */
export function observationCount(totals) {
  return num(totals.observations) + num(totals.cameraActivations);
}

/**
 * Reported entries less any administration still carried by an older pack.
 * @param {Record<string, unknown>} report
 */
function reportedEntries(report) {
  const withheld = rows(report.categories).filter((row) => WITHHELD_CATEGORIES.has(text(row.code)))
    .reduce((sum, row) => sum + num(row.entries), 0);
  return Math.max(0, num(obj(report.totals)?.entries) - withheld);
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
  return withoutWithheld(report);
}

/**
 * Itemised lines that belong to the same snapshot version, or [] when absent.
 * @param {unknown} activityLines
 */
export function readActivityLines(activityLines) {
  const document = obj(activityLines);
  return {
    lines: document?.version === ACTIVITY_REPORT_VERSION ? rows(document.lines).filter((line) => !isAdministrationLine(line)) : [],
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
      // An attended call-out leads with what was asked for; its action line is the response timing.
      if (!title && text(line.c) === 'call_out') title = issue;
      if (issue && !sameText(issue, noteText) && !repeats(issue, category) && !repeats(issue, title)) tags.push(issue);
    }
    if (noteText && !sameText(noteText, title)) lines.push({ text: noteText });
    const materials = materialsText(line, label);
    if (materials) lines.push({ label: 'Used', text: materials });
    const actionLabel = kind === 'work_order' ? 'Completion' : text(line.c) === 'call_out' ? 'Response' : 'Action taken';
    if (action && !sameText(action, noteText)) lines.push({ label: actionLabel, text: action });
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

/** Longest note, in words, that still reads as a status rather than a report ("Secure", "Provide access - no lock"). */
export const ROUTINE_STATUS_WORDS = 4;
const ROUTINE_CHECK_CATEGORIES = new Set(['patrol_visit', 'inspection']);
const ROUTINE_RESULTS_SHOWN = 4;

/** @param {string} value */
function statusWords(value) {
  return value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/**
 * A patrol or check (gate, lock, site) whose only record is a short status:
 * no action, nothing used, no photo, and not an incident. These are summarised
 * in Routine Checks instead of being listed one by one. The rule is structural
 * (length and shape), not a keyword list, so anything an officer wrote more
 * about stays itemised. Bob still reads these notes for potential incidents.
 * @param {Record<string, unknown>} line
 */
export function isRoutineCheck(line) {
  if (isIncidentLine(line) || text(line.k) !== 'event' || !ROUTINE_CHECK_CATEGORIES.has(text(line.c))) return false;
  if (text(line.ac) || num(line.ph) > 0 || rows(line.pr).length > 0 || rows(line.m).length > 0) return false;
  const status = text(line.n);
  return !status || (status.length <= 40 && statusWords(status) <= ROUTINE_STATUS_WORDS);
}

const INTERNAL_CAMERA_WORK = new Set(['maintenance', 'installation_removal']);

/**
 * Disclosure is separate from incident detection: Bob and the provider still
 * review the original lines, and a confirmed incident always survives.
 * @param {Record<string, unknown>} line
 */
export function isInternalWorkLine(line) {
  if (isIncidentLine(line) || reviewSectionCode(line)) return false;
  return isRoutineCheck(line)
    || (text(line.c) === 'inspection'
      && isRoutineCheck({ ...line, ph: 0, pr: [] }))
    || (INTERNAL_CAMERA_WORK.has(text(line.c)) && text(line.s) === 'camera');
}

/** @param {unknown} title @param {string} start @param {string} end */
export function clientReportTitle(title, start, end) {
  const multipleMonths = start.slice(0, 7) !== end.slice(0, 7);
  const value = text(title) || 'Monthly Report';
  return multipleMonths ? value.replace(/\bmonthly\b/gi, 'Period') : value;
}

/**
 * Remove known internal lines from the client figures as well as the detail.
 * Never use this projection as Bob's incident-review input.
 * @param {unknown} data
 * @param {unknown} activityLines
 */
export function clientActivitySnapshot(data, activityLines) {
  const report = readActivityReport(data);
  const { lines, notItemised } = readActivityLines(activityLines);
  const withheld = lines.filter(isInternalWorkLine);
  const visible = lines.filter((line) => !isInternalWorkLine(line));
  if (!report || !withheld.length) return { report, lines: visible, notItemised };
  const removedFor = (category) => withheld.filter((line) => text(line.c) === category).length;
  const removedPhotos = (source) => source.reduce((sum, line) => sum + num(line.ph), 0);
  const totals = obj(report.totals) ?? {};
  const byPlace = rows(report.byPlace).map((place) => {
    const removed = withheld.filter((line) => (text(line.p) || NO_PLACE_LABEL) === (text(place.place) || NO_PLACE_LABEL));
    return {
      ...place,
      entries: Math.max(0, num(place.entries) - removed.length),
      photos: Math.max(0, num(place.photos) - removedPhotos(removed)),
      categories: Object.fromEntries(Object.entries(obj(place.categories) ?? {}).map(([code, value]) => [
        code, Math.max(0, num(value) - removed.filter((line) => text(line.c) === code).length),
      ])),
    };
  }).filter((place) => num(place.entries) > 0);
  return {
    lines: visible,
    notItemised,
    report: {
      ...report,
      totals: {
        ...totals,
        entries: Math.max(0, num(totals.entries) - withheld.length),
        photos: Math.max(0, num(totals.photos) - removedPhotos(withheld)),
        patrolVisits: Math.max(0, num(totals.patrolVisits) - removedFor('patrol_visit')),
        places: Array.isArray(report.byPlace) ? byPlace.length : totals.places,
      },
      categories: rows(report.categories).map((row) => ({
        ...row,
        entries: Math.max(0, num(row.entries) - removedFor(text(row.code))),
        photos: Math.max(0, num(row.photos) - removedPhotos(withheld.filter((line) => text(line.c) === text(row.code)))),
      })).filter((row) => num(row.entries) > 0),
      byPlace,
      maintenance: {
        ...obj(report.maintenance),
        entries: Math.max(0, num(obj(report.maintenance)?.entries) - removedFor('maintenance')),
        bySubject: rows(obj(report.maintenance)?.bySubject).map((row) => ({
          ...row,
          entries: Math.max(0, num(row.entries) - withheld.filter((line) => text(line.c) === 'maintenance' && text(line.s) === text(row.code)).length),
        })).filter((row) => row.entries > 0),
      },
    },
  };
}

/** "secure." -> "Secure"; a blank note reads "Nothing to report". @param {Record<string, unknown>} line */
function routineResult(line) {
  const status = text(line.n).replace(/[.\s]+$/, '');
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Nothing to report';
}

/**
 * Routine checks by type: how many, at how many locations, and the recorded
 * results, most common first.
 * @param {Record<string, unknown>[]} lines
 * @param {ReturnType<typeof labeller>} label
 * @returns {{ check: string, checks: number, places: number, results: string }[]}
 */
export function routineCheckRows(lines, label) {
  /** @type {Map<string, { check: string, checks: number, places: Set<string>, results: Map<string, { text: string, count: number }> }>} */
  const byCheck = new Map();
  for (const line of lines) {
    if (!isRoutineCheck(line)) continue;
    const category = label('category', line.c);
    const subject = text(line.s) && !['other', 'general'].includes(text(line.s)) ? label('subject', line.s) : '';
    const check = subject && !sameText(subject, category) ? `${category} · ${subject}` : category;
    const row = byCheck.get(check) ?? { check, checks: 0, places: new Set(), results: new Map() };
    row.checks += 1;
    row.places.add(text(line.p) || NO_PLACE_LABEL);
    const result = routineResult(line);
    const key = result.toLowerCase();
    const seen = row.results.get(key) ?? { text: result, count: 0 };
    seen.count += 1;
    row.results.set(key, seen);
    byCheck.set(check, row);
  }
  return [...byCheck.values()]
    .sort((left, right) => right.checks - left.checks || left.check.localeCompare(right.check))
    .map((row) => {
      const results = [...row.results.values()].sort((left, right) => right.count - left.count || left.text.localeCompare(right.text));
      const shown = results.slice(0, ROUTINE_RESULTS_SHOWN).map((item) => `${item.text} ${fmt(item.count)}`);
      const rest = results.slice(ROUTINE_RESULTS_SHOWN).reduce((sum, item) => sum + item.count, 0);
      if (rest > 0) shown.push(`other ${fmt(rest)}`);
      return { check: row.check, checks: row.checks, places: row.places.size, results: shown.join(' · ') };
    });
}

/** Work itemised in its own client section: [report key, title]. */
const WORK_SECTIONS = /** @type {const} */ ([['maintenance', 'Maintenance and Repairs'], ['manufacture', 'Manufacture and Fabrication']]);
const TOP_HUNTING_AREAS = 10;

/**
 * @param {Record<string, unknown>} line
 * @param {string} key
 */
function isWorkLine(line, key) {
  return !isIncidentLine(line) && !reviewSectionCode(line) && text(line.c) === key;
}

/**
 * An entry worth listing under Notable Site Events (see notableEventBlocks).
 * @param {Record<string, unknown>} line
 */
export function isNotableEvent(line) {
  if (isIncidentLine(line) || reviewSectionCode(line) || isInternalWorkLine(line)) return false;
  const category = text(line.c);
  if (category === 'pest_control' || WORK_SECTIONS.some(([key]) => key === category)) return false;
  return Boolean(text(line.n) || text(line.ac) || num(line.ph) > 0 || (Array.isArray(line.pr) && line.pr.length > 0));
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
 * reviewer's executive summary (omitted when none is written), at a glance
 * with its charts and routine checks, then the activity tables with incidents
 * and investigations itemised, including logged entries a reviewer confirmed
 * as incidents (line.tri, see applyIncidentTriage). Returns null when the pack
 * has no client activity report so the caller keeps its legacy layout.
 * @param {unknown} data
 * @param {unknown} [activityLines]
 * @param {{ summary?: unknown, highlights?: unknown }} [options] the reviewer's executive summary and highlights, shown first
 * @returns {ReportBlock[] | null}
 */
export function serviceDeliveryRows(value) {
  const summary = obj(value);
  const counts = obj(summary?.counts);
  if (summary?.version !== 1 || !counts) return null;
  const labels = {
    reviewedReports: 'Reviewed officer incident and site hazard reports',
    completedDispatch: 'Completed dispatch jobs',
    completedStatic: 'Completed static attendances',
  };
  const result = [];
  for (const [kind, label] of Object.entries(labels)) {
    const row = obj(counts[kind]);
    if (!row || ![row.recorded, row.alreadyInActivity, row.additional].every((n) => Number.isSafeInteger(n) && n >= 0)
      || row.recorded !== row.alreadyInActivity + row.additional) return null;
    result.push([label, fmt(row.recorded), fmt(row.alreadyInActivity), fmt(row.additional)]);
  }
  return result;
}

export function monthlyActivityBlocks(data, activityLines, options = {}) {
  const { report, lines } = clientActivitySnapshot(data, activityLines);
  if (!report) return null;
  const label = labeller(report);
  const totals = obj(report.totals) ?? {};
  const pest = obj(report.pestControl) ?? {};
  /** @type {ReportBlock[]} */
  const blocks = [];

  blocks.push(...executiveSummaryBlocks(options?.summary, options?.highlights));

  const confirmedLines = lines.filter((line) => text(line.k) !== 'incident' && text(line.tri));
  blocks.push(section('At a Glance'));
  const metrics = [
    { label: 'Locations with activity', value: fmt(num(totals.places)) },
    { label: 'Entries recorded', value: fmt(reportedEntries(report)) },
    { label: 'Incidents', value: fmt(num(totals.incidents) + confirmedLines.length) },
    { label: 'Observations', value: fmt(observationCount(totals)) },
    { label: 'Patrols', value: fmt(num(totals.patrolVisits)) },
    { label: 'Photos', value: fmt(num(totals.photos)) },
    { label: 'Pest culls recorded', value: fmt(speciesCulls(report)) },
  ];
  const hunters = obj(report.hunterReturns);
  if (hunters) metrics.push({ label: 'Hunter-reported kills', value: fmt(num(hunters.animals)) });
  blocks.push({ kind: 'metrics', items: metrics });
  if (text(report.basis)) blocks.push(note(text(report.basis), 8.5, true));

  const categories = rows(report.categories).filter((row) => !WITHHELD_CATEGORIES.has(text(row.code)));
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

  for (const review of REVIEW_SECTIONS) {
    const reviewLines = lines.filter((line) => reviewSectionCode(line) === review.code);
    if (!reviewLines.length) continue;
    blocks.push(section(review.title));
    blocks.push(note(`${counted(reviewLines.length, review.one, review.many)} recorded during the period, in date order (New Zealand time).`, 9, true));
    for (const line of reviewLines) blocks.push(entryWithPlace(line, label));
  }

  for (const [key, title] of WORK_SECTIONS) {
    const workLines = lines.filter((line) => isWorkLine(line, key));
    if (!workLines.length) continue;
    blocks.push(section(title));
    blocks.push(note(`${counted(workLines.length, 'entry was', 'entries were')} recorded, listed below in date order (New Zealand time).`, 9, true));
    for (const line of workLines) blocks.push(entryWithPlace(line, label));
  }

  if (num(pest.entries) > 0) {
    blocks.push(section('Pest Control'));
    blocks.push(note(`${counted(pest.entries, 'pest-control entry was', 'pest-control entries were')} recorded. Species figures count recorded entries, not population estimates.`));
    const species = rows(pest.bySpecies);
    if (species.length) {
      blocks.push(table(
        [['Species', 187], ['Culls', 75, 'right'], ['Sightings', 75, 'right'], ['Other', 75, 'right'], ['Total', 75, 'right']],
        species.map((row) => [label('species', row.code), fmt(num(row.culls)), fmt(num(row.sightings)), fmt(num(row.other)), fmt(num(row.total))]),
      ));
    }
  }

  const serviceRows = serviceDeliveryRows(report.serviceDelivery);
  if (serviceRows) {
    blocks.push(section('Officer Service Evidence'));
    blocks.push(note('Agreement-attributed records. Provenance overlaps are already in the activity ledger; do not add these counts to activity totals. Private officer notes and identities are not included.'));
    blocks.push(table(
      [['Evidence', 217], ['Recorded', 75, 'right'], ['Already in activity', 95, 'right'], ['Additional records', 100, 'right']],
      serviceRows,
    ));
  }
  if (hunters && num(hunters.returns) <= 0) {
    // A client with a permit-return feed is told when nobody returned, so silence is not mistaken for a gap.
    blocks.push(section('Hunter Kill Returns'));
    blocks.push(note('No hunter kill or nil returns were submitted for hunts in the period.'));
  } else if (hunters) {
    blocks.push(section('Hunter Kill Returns'));
    blocks.push(note(`${counted(hunters.returns, 'hunter return was', 'hunter returns were')} submitted for hunts in the period: ${fmt(num(hunters.killReturns))} with kills and ${fmt(num(hunters.nilReturns))} nil. ${counted(hunters.animals, 'animal was', 'animals were')} reported. Figures are as reported by permit holders.`));
    const species = rows(hunters.bySpecies);
    if (species.length) {
      blocks.push(table(
        [['Species', 287], ['Animals reported', 100, 'right'], ['Returns', 100, 'right']],
        species.map((row) => [text(row.species), fmt(num(row.animals)), fmt(num(row.returns))]),
      ));
    }
    const areas = [...rows(hunters.byArea)].sort((left, right) => num(right.animals) - num(left.animals) || text(left.area).localeCompare(text(right.area)));
    const topAreas = areas.filter((row) => num(row.animals) > 0).slice(0, TOP_HUNTING_AREAS);
    if (topAreas.length) {
      blocks.push(note(`Top ${fmt(topAreas.length)} of ${counted(areas.length, 'hunting area', 'hunting areas')} by animals reported.`, 9, true));
      blocks.push(table(
        [['Hunting area', 187], ['Returns', 75, 'right'], ['With kills', 75, 'right'], ['Nil', 75, 'right'], ['Animals', 75, 'right']],
        topAreas.map((row) => [text(row.area), fmt(num(row.returns)), fmt(num(row.kill)), fmt(num(row.nil)), fmt(num(row.animals))]),
      ));
    }
  }
  return blocks;
}

/**
 * Notable site events for the client report: entries an officer described
 * (a comment, action or photo) that are not already reported as an incident,
 * review, maintenance or pest-control entry, and are not a status-only routine
 * check. Day-to-day entries with nothing described are counted, not listed.
 * @param {unknown} data
 * @param {unknown} activityLines
 * @returns {ReportBlock[]}
 */
export function notableEventBlocks(data, activityLines) {
  const report = readActivityReport(data);
  if (!report) return [];
  const label = labeller(report);
  const { lines } = readActivityLines(activityLines);
  const notable = lines.filter(isNotableEvent);
  if (!notable.length) return [];
  /** @type {ReportBlock[]} */
  const blocks = [section('Notable Site Events')];
  blocks.push(note('Other entries where an officer recorded something of note, by location in date order (New Zealand time).', 9, true));
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byPlace = new Map();
  for (const line of notable) {
    const place = text(line.p) || NO_PLACE_LABEL;
    byPlace.set(place, [...(byPlace.get(place) ?? []), line]);
  }
  const placeNames = [...byPlace.keys()].sort((left, right) => (left === NO_PLACE_LABEL ? 1 : 0) - (right === NO_PLACE_LABEL ? 1 : 0) || left.localeCompare(right));
  for (const place of placeNames) {
    const placeLines = byPlace.get(place) ?? [];
    blocks.push({ kind: 'subsection', title: place, detail: counted(placeLines.length, 'entry', 'entries') });
    for (const line of placeLines) blocks.push(entryFromLine(line, label));
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
  blocks.push(note('What happened at each location, in date order (New Zealand time). Incidents and observations, including camera card reviews, are listed in their own sections above; routine checks and internal camera servicing are not itemised.', 9, true));
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byPlace = new Map();
  for (const line of lines) {
    if (isIncidentLine(line) || reviewSectionCode(line) || isInternalWorkLine(line)) continue;
    const place = text(line.p) || NO_PLACE_LABEL;
    byPlace.set(place, [...(byPlace.get(place) ?? []), line]);
  }
  const placeNames = [...byPlace.keys()].sort((left, right) => (left === NO_PLACE_LABEL ? 1 : 0) - (right === NO_PLACE_LABEL ? 1 : 0) || left.localeCompare(right));
  for (const place of placeNames) {
    const placeLines = byPlace.get(place) ?? [];
    blocks.push({ kind: 'subsection', title: place, detail: counted(placeLines.length, 'entry', 'entries') });
    for (const line of placeLines) blocks.push(entryFromLine(line, label));
  }
  if (notItemised > 0) {
    blocks.push(note(`A further ${counted(notItemised, 'entry', 'entries')} from this period ${isAre(notItemised)} included in the totals above and held on file.`, 9, true));
  }
  return blocks;
}

/**
 * Short email summary: one headline sentence plus entries by type of activity.
 * @param {unknown} data
 * @param {{ confirmedIncidents?: number, activityLines?: unknown }} [options] logged entries a reviewer confirmed as incidents, counted with recorded incidents
 * @returns {{ headline: string, categories: string[][] } | null}
 */
export function activityEmailSummary(data, options = {}) {
  const { report } = clientActivitySnapshot(data, options.activityLines);
  if (!report) return null;
  const label = labeller(report);
  const reported = obj(report.totals) ?? {};
  const totals = {
    ...reported,
    entries: reportedEntries(report),
    observations: observationCount(reported),
    incidents: num(reported.incidents) + Math.max(0, Math.trunc(num(options.confirmedIncidents))),
  };
  const hunters = obj(report.hunterReturns);
  const hunterSentence = hunters && num(hunters.returns) > 0
    ? ` Permit holders submitted ${counted(hunters.returns, 'hunter return', 'hunter returns')} reporting ${counted(hunters.animals, 'animal', 'animals')}.`
    : '';
  return {
    headline: `${counted(totals.entries, 'entry', 'entries')} recorded across ${counted(totals.places, 'location', 'locations')}, including ${counted(totals.incidents, 'incident', 'incidents')}, ${counted(totals.observations, 'observation', 'observations')} and ${counted(totals.photos, 'photo', 'photos')}.${hunterSentence}`,
    categories: rows(report.categories).filter((row) => !WITHHELD_CATEGORIES.has(text(row.code))).map((row) => [label('category', row.code), fmt(num(row.entries))]),
  };
}
