// Reads the frozen client month-end activity report written by public.build_agreement_activity_report
// (monthly_report_packs.data.activityReport and .activity_lines). Labels, entry wording, the routine
// patrol fold and the site-log grouping mirror supabase/functions/_shared/report-activity-sections.mjs
// so the provider review shows exactly what the client receives in the PDF.

import { readServiceDelivery, type ServiceDeliveryCount } from './reportServiceDelivery';

export const ACTIVITY_REPORT_VERSION = 2;
export const ACTIVITY_ACCOUNTING_VERSION = 1;
export const NO_PLACE_LABEL = 'Not location-specific';
export const REPORT_PHOTO_BUCKETS: readonly string[] = ['bob-uploads', 'scans'];

type Json = Record<string, unknown>;

export interface ActivityCode { code: string; entries: number }
export interface ActivityCount extends ActivityCode { photos: number }
export interface ActivityPlace { place: string; entries: number; photos: number; categories: Record<string, number> }
export interface ActivitySpecies { code: string; culls: number; sightings: number; other: number; total: number }
export interface ActivityAmmunition { calibre: string; entries: number; rounds: number | null }
export interface ActivityWork { entries: number; bySubject: ActivityCode[]; completed: number; open: number }
export interface ActivityModule { module: string; entries: number; withPhoto: number; photos: number }
export interface HunterReturns {
  returns: number; killReturns: number; nilReturns: number; animals: number;
  bySpecies: Array<{ species: string; animals: number; returns: number }>;
  byArea: Array<{ area: string; returns: number; kill: number; nil: number; animals: number }>;
}

export interface ActivityReport {
  basis: string;
  totals: {
    entries: number; events: number; observations: number; workOrders: number; incidents: number;
    patrolVisits: number; cameraActivations: number; withNotes: number; places: number; photos: number;
  };
  categories: ActivityCount[];
  byPlace: ActivityPlace[];
  pest: { entries: number; bySpecies: ActivitySpecies[]; byActivity: ActivityCode[]; byEquipment: ActivityCode[]; ammunition: ActivityAmmunition[] };
  maintenance: ActivityWork;
  manufacture: ActivityWork;
  observations: { total: number; withPhoto: number; photos: number; byModule: ActivityModule[] };
  incidents: { total: number; investigations: number; withMedia: number; bySeverity: ActivityCode[]; byStatus: ActivityCode[] };
  /** Base44 RAMS hunter kill/nil returns; null when the client has no hunter-return programme. */
  hunterReturns: HunterReturns | null;
  serviceDelivery?: ServiceDeliveryCount[] | null;
  accountedFor: {
    eventsInScope: number; mirrorEventsExcluded: number; activityEvents: number; observationsInScope: number;
    workOrdersInScope: number; incidentsInScope: number; entries: number; reported: number; operationalWithheld: number;
    withheldTravelAdmin: number; withheldShiftMarkers: number; withheldRoutineCards: number; withheldDuplicates: number; itemised: number; notItemised: number; unclassified: number; reconciled: boolean;
  };
  labels: Record<string, Record<string, string>>;
}

export interface ReportPhotoRef { bucket: string; path: string }

export interface ActivityLine {
  /** Content key shared with report_incident_triage; see activityLineKey. */
  key: string;
  /** Incident type a reviewer confirmed for this entry; empty when not confirmed. */
  confirmedType: string;
  /** Administration carried by an older pack: kept out of the client report unless confirmed as an incident (isReportedLine). */
  withheld: boolean;
  date: string;
  time: string;
  place: string;
  kind: 'event' | 'observation' | 'work_order' | 'incident' | string;
  category: string;
  module: string;
  activity: string;
  subject: string;
  species: string;
  equipment: string;
  job: string;
  materials: Array<{ type: string; calibre: string; quantity: number | null }>;
  workOrderStatus: string;
  title: string;
  note: string;
  action: string;
  incidentType: string;
  severity: string;
  status: string;
  investigation: string;
  investigationStatus: string;
  photos: number;
  photoRefs: ReportPhotoRef[];
  videos: number;
}

export interface ActivityEntry {
  when: string;
  tags: string[];
  title: string;
  lines: Array<{ label?: string; text: string }>;
  photos: ReportPhotoRef[];
  photoCount: number;
  tone: 'incident' | 'default';
}

export interface SiteLogGroup { place: string; lines: ActivityLine[] }

const object = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object).filter((item): item is Json => item !== null) : []);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const code = (row: Json): ActivityCode => ({ code: str(row.code), entries: num(row.entries) });
const count = (row: Json): ActivityCount => ({ ...code(row), photos: num(row.photos) });

function work(value: unknown): ActivityWork {
  const row = object(value) ?? {};
  const orders = object(row.workOrders) ?? {};
  return { entries: num(row.entries), bySubject: list(row.bySubject).map(code), completed: num(orders.completed), open: num(orders.open) };
}

function readHunterReturns(value: unknown): HunterReturns | null {
  const row = object(value);
  if (!row) return null;
  return {
    returns: num(row.returns), killReturns: num(row.killReturns), nilReturns: num(row.nilReturns), animals: num(row.animals),
    bySpecies: list(row.bySpecies).map((item) => ({ species: str(item.species), animals: num(item.animals), returns: num(item.returns) })),
    byArea: list(row.byArea).map((item) => ({ area: str(item.area), returns: num(item.returns), kill: num(item.kill), nil: num(item.nil), animals: num(item.animals) })),
  };
}

export function humaniseCode(value: string): string {
  const text = value.replaceAll('_', ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** Incident types a reviewer can confirm; matches report_incident_triage and the shared report sections. */
export const INCIDENT_TYPE_LABELS: Readonly<Record<string, string>> = {
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

export function incidentTypeLabel(code: string): string {
  return INCIDENT_TYPE_LABELS[code] || (code ? humaniseCode(code) : 'Incident');
}

const LINE_KEY_IGNORED = new Set(['pr', 'ph', 'vid', 'tri', 'key', 'lk', 'pv']);
const STORED_LINE_KEY = /^v1:[0-9a-f]{14}$/;

/**
 * Content key of one frozen activity line (snapshot lines carry no record id):
 * every content field except photo and video counts and refs, which can change
 * as media arrives. A line reworded by Bob's privacy check keeps its original
 * key in lk. Must match activityLineKey in
 * supabase/functions/_shared/report-activity-sections.mjs.
 */
export function activityLineKey(line: Json): string {
  if (typeof line.lk === 'string' && STORED_LINE_KEY.test(line.lk)) return line.lk;
  const source = JSON.stringify(Object.keys(line)
    .filter((field) => !LINE_KEY_IGNORED.has(field))
    .sort()
    .map((field) => [field, typeof line[field] === 'string' ? (line[field] as string).trim() : line[field] ?? null])
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

export type TriageDecision = 'unreviewed' | 'incident' | 'not_incident';

/** Bob's assessment of one entry and the reviewer's decision, from list_report_incident_triage. */
export interface IncidentTriage {
  lineKey: string;
  bobFlagged: boolean;
  bobType: string;
  bobReason: string;
  bobConfidence: number | null;
  decision: TriageDecision;
  incidentType: string;
  note: string;
  decidedAt: string;
  /** A sent report already covers this entry, so a change is a recorded reclassification. */
  inSentReport: boolean;
}

export function readIncidentTriage(value: unknown): IncidentTriage[] {
  return list(value).flatMap((row) => {
    const lineKey = str(row.line_key);
    if (!lineKey) return [];
    const decision = str(row.decision);
    return [{
      lineKey,
      bobFlagged: row.bob_flagged === true,
      bobType: str(row.bob_incident_type),
      bobReason: str(row.bob_reason),
      bobConfidence: typeof row.bob_confidence === 'number' ? row.bob_confidence : typeof row.bob_confidence === 'string' && row.bob_confidence ? Number(row.bob_confidence) : null,
      decision: decision === 'incident' || decision === 'not_incident' ? decision : 'unreviewed',
      incidentType: str(row.incident_type),
      note: str(row.decision_note),
      decidedAt: str(row.decided_at),
      inSentReport: row.in_sent_report === true,
    }];
  });
}

/** Marks the lines a reviewer confirmed as incidents, as the client PDF does. */
export function applyIncidentTriage(lines: ActivityLine[], triage: Map<string, IncidentTriage>): ActivityLine[] {
  if (!triage.size) return lines;
  return lines.map((line) => {
    const row = line.kind === 'incident' ? undefined : triage.get(line.key);
    const confirmedType = row?.decision === 'incident' ? row.incidentType || 'other' : '';
    return confirmedType === line.confirmedType ? line : { ...line, confirmedType };
  });
}

/** A recorded incident or an entry confirmed as one on review. */
export function isIncidentLine(line: ActivityLine): boolean {
  return line.kind === 'incident' || Boolean(line.confirmedType);
}

/** Whether the client report shows this entry. Apply incident triage first, so confirmed administration entries stay in. */
export function isReportedLine(line: ActivityLine): boolean {
  return !line.withheld || isIncidentLine(line);
}

export interface TextRun { text: string; bold: boolean }
export interface MarkupItem { style: 'heading' | 'bullet' | 'paragraph'; runs: TextRun[] }

function markupRuns(value: string): TextRun[] {
  const runs: TextRun[] = [];
  value.split('**').forEach((part, index) => {
    const cleaned = part.replace(/__|`/g, '');
    if (cleaned) runs.push({ text: cleaned, bold: index % 2 === 1 });
  });
  return runs.length ? runs : [{ text: value.replace(/\*\*|__|`/g, ''), bold: false }];
}

/**
 * The reviewer's summary as headings, bullets and paragraphs, as in the PDF and email:
 * **bold**, "# heading" or a wholly bold line, and "* ", "- " or "• " bullets.
 */
export function summaryMarkup(value: string): MarkupItem[] {
  const items: MarkupItem[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) items.push({ style: 'paragraph', runs: markupRuns(paragraph.join(' ')) });
    paragraph = [];
  };
  for (const raw of value.replace(/\r\n/g, '\n').split('\n')) {
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

/** The executive summary without Bob's own "Executive Summary: ..." title, for surfaces that already show one. */
export function executiveSummaryMarkup(value: string): MarkupItem[] {
  const items = summaryMarkup(value);
  if (items[0]?.style === 'heading' && /^executive summary\b/i.test(items[0].runs.map((run) => run.text).join(''))) items.shift();
  return items;
}

const FIXED_LABELS: Record<string, Record<string, string>> = {
  incidentType: { cctv_bookmark: 'CCTV review' },
  severity: { low: 'Low', standard: 'Standard', high: 'High', critical: 'Critical' },
  incidentStatus: { open: 'Open', in_review: 'Under review', resolved: 'Resolved', escalated: 'Escalated' },
  investigationStatus: { open: 'Open', active: 'Active', awaiting_evidence: 'Awaiting evidence', awaiting_review: 'Awaiting review', referred: 'Referred', court: 'Before the court', resolved: 'Resolved', closed: 'Closed' },
  workOrderStatus: { approved: 'Scheduled', in_progress: 'In progress', completed: 'Completed' },
  module: { unknown: 'General' },
};

export function readActivityReport(data: unknown): ActivityReport | null {
  const report = object(object(data)?.activityReport);
  const totals = object(report?.totals);
  if (!report || report.version !== ACTIVITY_REPORT_VERSION || !totals) return null;
  const pest = object(report.pestControl) ?? {};
  const observations = object(report.observations) ?? {};
  const incidents = object(report.incidents) ?? {};
  const accounted = object(report.accountedFor) ?? {};
  const labels: Record<string, Record<string, string>> = {};
  for (const [dim, map] of Object.entries(object(report.labels) ?? {})) {
    labels[dim] = Object.fromEntries(Object.entries(object(map) ?? {}).map(([key, value]) => [key, str(value)]).filter(([, value]) => value !== ''));
  }
  const allCategories = list(report.categories).map(count);
  // Administration is withheld from the client report; older packs still carry it (WITHHELD_CATEGORIES),
  // so every aggregate drops it the same way, as withoutWithheld does in the PDF.
  const withheldEntries = allCategories.filter((row) => WITHHELD_CATEGORIES.has(row.code)).reduce((sum, row) => sum + row.entries, 0);
  const byPlace = list(report.byPlace).map((row) => {
    const placeCategories = Object.entries(object(row.categories) ?? {}).map(([key, value]) => [key, num(value)] as const);
    const removed = withheldEntries ? placeCategories.filter(([key]) => WITHHELD_CATEGORIES.has(key)).reduce((sum, [, value]) => sum + value, 0) : 0;
    return {
      place: str(row.place) || NO_PLACE_LABEL, entries: Math.max(0, num(row.entries) - removed), photos: num(row.photos),
      categories: Object.fromEntries(withheldEntries ? placeCategories.filter(([key]) => !WITHHELD_CATEGORIES.has(key)) : placeCategories),
    };
  }).filter((row) => !withheldEntries || row.entries > 0);
  const places = withheldEntries && Array.isArray(report.byPlace) ? byPlace.length : num(totals.places);
  return {
    basis: str(report.basis),
    totals: {
      entries: Math.max(0, num(totals.entries) - withheldEntries), events: num(totals.events), observations: num(totals.observations), workOrders: num(totals.workOrders),
      incidents: num(totals.incidents), patrolVisits: num(totals.patrolVisits), cameraActivations: num(totals.cameraActivations),
      withNotes: num(totals.withNotes), places, photos: num(totals.photos),
    },
    categories: allCategories.filter((row) => !WITHHELD_CATEGORIES.has(row.code)),
    byPlace,
    pest: {
      entries: num(pest.entries),
      bySpecies: list(pest.bySpecies).map((row) => ({ code: str(row.code), culls: num(row.culls), sightings: num(row.sightings), other: num(row.other), total: num(row.total) })),
      byActivity: list(pest.byActivity).map(code),
      byEquipment: list(pest.byEquipment).map(code),
      ammunition: list(pest.ammunition).map((row) => ({ calibre: str(row.calibre), entries: num(row.entries), rounds: typeof row.rounds === 'number' ? row.rounds : null })),
    },
    maintenance: work(report.maintenance),
    manufacture: work(report.manufacture),
    observations: {
      total: num(observations.total), withPhoto: num(observations.withPhoto), photos: num(observations.photos),
      byModule: list(observations.byModule).map((row) => ({ module: str(row.module), entries: num(row.entries), withPhoto: num(row.withPhoto), photos: num(row.photos) })),
    },
    incidents: {
      total: num(incidents.total), investigations: num(incidents.investigations), withMedia: num(incidents.withMedia),
      bySeverity: list(incidents.bySeverity).map(code), byStatus: list(incidents.byStatus).map(code),
    },
    hunterReturns: readHunterReturns(report.hunterReturns),
    serviceDelivery: readServiceDelivery(report.serviceDelivery),
    accountedFor: {
      eventsInScope: num(accounted.eventsInScope), mirrorEventsExcluded: num(accounted.mirrorEventsExcluded), activityEvents: num(accounted.activityEvents),
      observationsInScope: num(accounted.observationsInScope), workOrdersInScope: num(accounted.workOrdersInScope), incidentsInScope: num(accounted.incidentsInScope),
      entries: num(accounted.entries), reported: num(accounted.reported), operationalWithheld: num(accounted.operationalWithheld),
      withheldTravelAdmin: num(accounted.withheldTravelAdmin), withheldShiftMarkers: num(accounted.withheldShiftMarkers),
      withheldRoutineCards: num(accounted.withheldRoutineCards), withheldDuplicates: num(accounted.withheldDuplicates),
      itemised: num(accounted.itemised), notItemised: num(accounted.notItemised), unclassified: num(accounted.unclassified), reconciled: accounted.reconciled === true,
    },
    labels,
  };
}

export function activityLabel(report: Pick<ActivityReport, 'labels'>, dim: string, value: string): string {
  if (!value) return '';
  return report.labels[dim]?.[value] || FIXED_LABELS[dim]?.[value] || humaniseCode(value);
}

// Photos named for NZTA are privileged and never go into a client report.
export const PRIVILEGED_PHOTO = /nzta/i;

function photoRefs(value: unknown): ReportPhotoRef[] {
  return list(value)
    .map((ref) => ({ bucket: str(ref.b), path: str(ref.p) }))
    .filter((ref) => ref.bucket && ref.path && !/^https?:/i.test(ref.path) && !PRIVILEGED_PHOTO.test(ref.path));
}

export function readActivityLines(value: unknown): { lines: ActivityLine[]; notItemised: number } | null {
  const document = object(value);
  if (!document || document.version !== ACTIVITY_REPORT_VERSION) return null;
  return {
    notItemised: num(document.notItemised),
    lines: list(document.lines).map((line) => ({
      key: activityLineKey(line), confirmedType: '', withheld: isAdministrationLine(line),
      date: str(line.d), time: str(line.t), place: str(line.p) || NO_PLACE_LABEL, kind: str(line.k), category: str(line.c), module: str(line.mo),
      activity: str(line.a), subject: str(line.s), species: str(line.sp), equipment: str(line.eq), job: str(line.j),
      materials: list(line.m).map((item) => ({ type: str(item.t), calibre: str(item.cal), quantity: typeof item.q === 'number' ? item.q : null })),
      workOrderStatus: str(line.ws), title: str(line.ti), note: str(line.n), action: str(line.ac),
      incidentType: str(line.it), severity: str(line.sev), status: str(line.st), investigation: str(line.inv), investigationStatus: str(line.ivs),
      photos: num(line.ph), photoRefs: photoRefs(line.pr), videos: num(line.vid),
    })),
  };
}

/** Storage objects the review may sign: report photo buckets only, never URLs or parent-directory paths. */
export function isReportPhotoRef(ref: ReportPhotoRef): boolean {
  return REPORT_PHOTO_BUCKETS.includes(ref.bucket) && !/^https?:/i.test(ref.path) && !ref.path.split('/').includes('..');
}

const formats = new Map<number, Intl.NumberFormat>();
export function formatActivityNumber(value: number, digits = 0): string {
  if (!formats.has(digits)) formats.set(digits, new Intl.NumberFormat('en-NZ', { maximumFractionDigits: digits }));
  return formats.get(digits)!.format(value);
}

/** "1 entry" / "3 entries": client-facing copy must not read "1 entries". */
export const countedText = (value: number, one: string, many: string) => `${formatActivityNumber(value)} ${value === 1 ? one : many}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-14" -> "Wed 14 Oct 2026"; snapshot dates are already New Zealand dates. */
export function reportDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${DAYS[day.getUTCDay()]} ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

const normText = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameText = (left: string, right: string) => Boolean(left && right && normText(left) === normText(right));
// A short imported label such as "Pest" adds nothing to a category of "Pest control".
const repeats = (label: string, other: string) => Boolean(label && other && normText(other).startsWith(normText(label)));

/** A patrol or site check with nothing written, no photo and nothing used; counted per location, not listed. */
export function isRoutineLine(line: ActivityLine): boolean {
  return line.kind === 'event' && line.category === 'patrol_visit'
    && !line.note && !line.action && line.photos === 0 && line.materials.length === 0;
}

function materialsText(report: Pick<ActivityReport, 'labels'>, line: ActivityLine): string {
  return line.materials.map((item) => {
    const quantity = item.quantity === null ? '' : ` × ${formatActivityNumber(item.quantity, 2)}`;
    const calibre = item.calibre && item.calibre !== 'unspecified' ? ` ${item.calibre}` : '';
    return `${activityLabel(report, 'material', item.type)}${calibre}${quantity}`;
  }).join(', ');
}

/** The client-facing entry: when, what kind, what was seen or done, what was done about it, and the photos. */
export function describeActivityLine(report: Pick<ActivityReport, 'labels'>, line: ActivityLine): ActivityEntry {
  const label = (dim: string, value: string) => activityLabel(report, dim, value);
  const tags: string[] = [];
  const lines: ActivityEntry['lines'] = [];
  let title = '';
  if (line.kind === 'incident') {
    title = label('incidentType', line.incidentType) || 'Incident';
    tags.push(`${label('severity', line.severity || 'standard')} severity`, label('incidentStatus', line.status || 'open'));
    if (line.note) lines.push({ text: line.note });
    if (line.investigation) lines.push({ label: 'Investigation', text: [line.investigation, label('investigationStatus', line.investigationStatus)].filter(Boolean).join(' · ') });
    if (line.videos > 0) lines.push({ label: 'Video', text: `${countedText(line.videos, 'video clip', 'video clips')} held on file` });
  } else {
    const category = label('category', line.category);
    tags.push(category);
    if (line.kind === 'observation') tags.push(`${label('module', line.module || 'unknown')} observation`);
    if (line.kind === 'work_order') {
      title = line.title;
      if (line.workOrderStatus) tags.push(label('workOrderStatus', line.workOrderStatus));
    } else {
      title = [label('activity', line.activity), label('subject', line.subject), label('species', line.species), label('equipment', line.equipment)]
        .filter((value, index, all) => value && all.indexOf(value) === index && !sameText(value, category))
        .join(' · ');
      if (line.title && !sameText(line.title, line.note) && !repeats(line.title, category) && !repeats(line.title, title)) tags.push(line.title);
    }
    if (line.note && !sameText(line.note, title)) lines.push({ text: line.note });
    const materials = materialsText(report, line);
    if (materials) lines.push({ label: 'Used', text: materials });
    if (line.action && !sameText(line.action, line.note)) lines.push({ label: line.kind === 'work_order' ? 'Completion' : 'Action taken', text: line.action });
  }
  if (line.job) tags.push(`Ref ${line.job}`);
  if (line.kind !== 'incident' && line.confirmedType) {
    return {
      when: [reportDate(line.date), line.time].filter(Boolean).join(' · '),
      tags: ['Confirmed on review', ...tags.filter(Boolean)],
      title: incidentTypeLabel(line.confirmedType),
      lines: [...(title ? [{ label: 'Recorded as', text: title }] : []), ...lines],
      photos: line.photoRefs,
      photoCount: line.photos,
      tone: 'incident',
    };
  }
  return {
    when: [reportDate(line.date), line.time].filter(Boolean).join(' · '),
    tags: tags.filter(Boolean),
    title,
    lines,
    photos: line.photoRefs,
    photoCount: line.photos,
    tone: line.kind === 'incident' ? 'incident' : 'default',
  };
}

/** Categories withheld from the client report (owner ruling 2026-11-05: admin records are removed). */
export const WITHHELD_CATEGORIES: ReadonlySet<string> = new Set(['administration', 'travel_admin']);

/** Administration and desk entries carried by packs generated before the ruling (isAdministrationLine in the PDF). */
function isAdministrationLine(line: Json): boolean {
  // Older packs file midnight card reviews under administration; they are observations and stay in.
  return str(line.k) !== 'incident' && !str(line.tri) && WITHHELD_CATEGORIES.has(str(line.c))
    && str(line.ti).toLowerCase().replace(/[^a-z]/g, '') !== 'cardreview';
}

/** A camera card review or other observation; card reviews are observations (isObservationLine in the PDF). */
export function isObservationLine(line: ActivityLine): boolean {
  if (isIncidentLine(line)) return false;
  return line.kind === 'observation' || line.category === 'camera_activation' || line.category === 'vehicle_observation'
    || line.title.toLowerCase().replace(/[^a-z]/g, '') === 'cardreview';
}

/** Observations, including camera card reviews, have their own section, as in the PDF (REVIEW_SECTIONS). */
export const REVIEW_SECTIONS = [
  { code: 'observation', title: 'Observations', one: 'observation', many: 'observations' },
] as const;

/** The review section an entry belongs in, or '' when it stays in the site log. */
export function reviewSectionCode(line: ActivityLine): string {
  return isObservationLine(line) ? 'observation' : '';
}

/** Observations for At a Glance: recorded observations plus camera card reviews (observationCount in the PDF). */
export function observationCount(totals: Pick<ActivityReport['totals'], 'observations' | 'cameraActivations'>): number {
  return totals.observations + totals.cameraActivations;
}

/** Longest note, in words, that still reads as a status rather than a report (ROUTINE_STATUS_WORDS in the PDF). */
export const ROUTINE_STATUS_WORDS = 4;
const ROUTINE_CHECK_CATEGORIES = new Set(['patrol_visit', 'inspection']);
const ROUTINE_RESULTS_SHOWN = 4;

/**
 * A patrol or check whose only record is a short status (no action, nothing used, no photo, not an incident).
 * Summarised under Routine checks rather than listed; structural, not a keyword list.
 */
export function isRoutineCheck(line: ActivityLine): boolean {
  if (isIncidentLine(line) || line.kind !== 'event' || !ROUTINE_CHECK_CATEGORIES.has(line.category)) return false;
  if (line.action || line.photos > 0 || line.photoRefs.length > 0 || line.materials.length > 0) return false;
  const status = line.note.trim();
  return !status || (status.length <= 40 && (status.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= ROUTINE_STATUS_WORDS);
}

const INTERNAL_CAMERA_WORK = new Set(['maintenance', 'installation_removal']);

/** Client disclosure only; the original lines remain available to Bob and the reviewer. Mirrors the PDF. */
export function isInternalWorkLine(line: ActivityLine): boolean {
  if (isIncidentLine(line) || reviewSectionCode(line)) return false;
  return isRoutineCheck(line)
    || (line.category === 'inspection' && isRoutineCheck({ ...line, photos: 0, photoRefs: [] }))
    || (INTERNAL_CAMERA_WORK.has(line.category) && line.subject === 'camera');
}

/** The same client-only aggregate projection used by the PDF and email. Apply incident triage first. */
export function clientActivityReport(report: ActivityReport, lines: ActivityLine[]): ActivityReport {
  const withheld = lines.filter(isInternalWorkLine);
  if (!withheld.length) return report;
  const removedFor = (category: string) => withheld.filter((line) => line.category === category).length;
  const removedPhotos = (source: ActivityLine[]) => source.reduce((sum, line) => sum + line.photos, 0);
  const byPlace = report.byPlace.map((place) => {
    const removed = withheld.filter((line) => (line.place || NO_PLACE_LABEL) === (place.place || NO_PLACE_LABEL));
    return {
      ...place,
      entries: Math.max(0, place.entries - removed.length),
      photos: Math.max(0, place.photos - removedPhotos(removed)),
      categories: Object.fromEntries(Object.entries(place.categories).map(([code, value]) => [
        code, Math.max(0, value - removed.filter((line) => line.category === code).length),
      ])),
    };
  }).filter((place) => place.entries > 0);
  return {
    ...report,
    totals: {
      ...report.totals,
      entries: Math.max(0, report.totals.entries - withheld.length),
      photos: Math.max(0, report.totals.photos - removedPhotos(withheld)),
      patrolVisits: Math.max(0, report.totals.patrolVisits - removedFor('patrol_visit')),
      places: byPlace.length,
    },
    categories: report.categories.map((row) => ({
      ...row,
      entries: Math.max(0, row.entries - removedFor(row.code)),
      photos: Math.max(0, row.photos - removedPhotos(withheld.filter((line) => line.category === row.code))),
    })).filter((row) => row.entries > 0),
    byPlace,
    maintenance: {
      ...report.maintenance,
      entries: Math.max(0, report.maintenance.entries - removedFor('maintenance')),
      bySubject: report.maintenance.bySubject.map((row) => ({
        ...row,
        entries: Math.max(0, row.entries - withheld.filter((line) => line.category === 'maintenance' && line.subject === row.code).length),
      })).filter((row) => row.entries > 0),
    },
  };
}

export interface RoutineCheckRow { check: string; checks: number; places: number; results: string }

/** Routine checks by type with their recorded results, most common first (routineCheckRows in the PDF). */
export function routineCheckRows(report: Pick<ActivityReport, 'labels'>, lines: ActivityLine[]): RoutineCheckRow[] {
  const byCheck = new Map<string, { check: string; checks: number; places: Set<string>; results: Map<string, { text: string; count: number }> }>();
  for (const line of lines) {
    if (!isRoutineCheck(line)) continue;
    const category = activityLabel(report, 'category', line.category);
    const subject = line.subject && !['other', 'general'].includes(line.subject) ? activityLabel(report, 'subject', line.subject) : '';
    const check = subject && !sameText(subject, category) ? `${category} ? ${subject}` : category;
    const row = byCheck.get(check) ?? { check, checks: 0, places: new Set<string>(), results: new Map() };
    row.checks += 1;
    row.places.add(line.place || NO_PLACE_LABEL);
    const status = line.note.trim().replace(/[.\s]+$/, '');
    const result = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Nothing to report';
    const seen = row.results.get(result.toLowerCase()) ?? { text: result, count: 0 };
    seen.count += 1;
    row.results.set(result.toLowerCase(), seen);
    byCheck.set(check, row);
  }
  return [...byCheck.values()]
    .sort((left, right) => right.checks - left.checks || left.check.localeCompare(right.check))
    .map((row) => {
      const results = [...row.results.values()].sort((left, right) => right.count - left.count || left.text.localeCompare(right.text));
      const shown = results.slice(0, ROUTINE_RESULTS_SHOWN).map((item) => `${item.text} ${formatActivityNumber(item.count)}`);
      const rest = results.slice(ROUTINE_RESULTS_SHOWN).reduce((sum, item) => sum + item.count, 0);
      if (rest > 0) shown.push(`other ${formatActivityNumber(rest)}`);
      return { check: row.check, checks: row.checks, places: row.places.size, results: shown.join(' ? ') };
    });
}

/** Site-log grouping as in the PDF: incidents, observations and routine checks excluded (they have their own sections), locations A-Z, "Not location-specific" last. */
export function siteLogGroups(lines: ActivityLine[]): SiteLogGroup[] {
  const byPlace = new Map<string, ActivityLine[]>();
  for (const line of lines) {
    if (isIncidentLine(line) || reviewSectionCode(line) || isInternalWorkLine(line)) continue;
    byPlace.set(line.place, [...(byPlace.get(line.place) ?? []), line]);
  }
  return [...byPlace.keys()]
    .sort((left, right) => (left === NO_PLACE_LABEL ? 1 : 0) - (right === NO_PLACE_LABEL ? 1 : 0) || left.localeCompare(right))
    .map((place) => ({ place, lines: byPlace.get(place) ?? [] }));
}

/** Paragraphs of reviewer text, split on blank lines. */
export function textParagraphs(value: string): string[] {
  return value.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export interface ActivityAccounting {
  packUpdatedAt: string;
  checkedAt: string;
  freshness: { hasFrozenReport: boolean; frozenEntries: number | null; liveEntries: number; matchesLive: boolean; changedCategories: Array<{ code: string; frozen: number; live: number }> };
  provenance: {
    events: { inScope: number; withLedger: number; withoutLedger: number };
    observations: { inScope: number; withLedger: number; withoutLedger: number };
    sources: Array<{ sourceFile: string; sourceSheet: string; batchStatus: string; batchRows: number | null; batchDuplicates: number | null; batchUnresolved: number | null; events: number; observations: number }>;
  };
  clientMonth: { entries: number; thisAgreement: number; otherAgreements: number; noAgreementPlace: number; unlinkedPlaces: Array<{ place: string; entries: number }> };
  exceptions: { futureDated: number; sparseYears: Array<{ year: number; entries: number }>; supersededDuplicates: number };
}

export type AccountingProblem = { kind: 'permission' | 'unavailable' | 'missing' | 'stale' | 'error'; message: string };

export function activityAccountingProblem(error: { code?: string | null; message?: string | null } | null | undefined): AccountingProblem {
  const message = error?.message ?? '';
  if (/administrator (access )?required/i.test(message)) {
    return { kind: 'permission', message: 'Only a provider administrator for this organisation can run the live accounting check.' };
  }
  if (error?.code === 'PGRST202' || /could not find the function/i.test(message)) {
    return { kind: 'unavailable', message: 'The live accounting check is not available in this environment yet.' };
  }
  if (/report pack not found/i.test(message)) {
    return { kind: 'missing', message: 'This report pack is no longer available. Refresh the report list.' };
  }
  return { kind: 'error', message: 'The live accounting check could not be completed. Try again.' };
}

const nullableNum = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const ledger = (value: unknown) => {
  const row = object(value) ?? {};
  return { inScope: num(row.inScope), withLedger: num(row.withLedger), withoutLedger: num(row.withoutLedger) };
};

export function readActivityAccounting(value: unknown): ActivityAccounting | null {
  const result = object(value);
  if (!result || result.version !== ACTIVITY_ACCOUNTING_VERSION) return null;
  const freshness = object(result.freshness) ?? {};
  const provenance = object(result.provenance) ?? {};
  const month = object(result.clientMonth) ?? {};
  const exceptions = object(result.exceptions) ?? {};
  return {
    packUpdatedAt: str(result.packUpdatedAt),
    checkedAt: str(result.checkedAt),
    freshness: {
      hasFrozenReport: freshness.hasFrozenReport === true,
      frozenEntries: nullableNum(freshness.frozenEntries),
      liveEntries: num(freshness.liveEntries),
      matchesLive: freshness.matchesLive === true,
      changedCategories: list(freshness.changedCategories).map((row) => ({ code: str(row.code), frozen: num(row.frozen), live: num(row.live) })),
    },
    provenance: {
      events: ledger(provenance.events),
      observations: ledger(provenance.observations),
      sources: list(provenance.sources).map((row) => ({
        sourceFile: str(row.sourceFile) || 'Unnamed file', sourceSheet: str(row.sourceSheet), batchStatus: str(row.batchStatus),
        batchRows: nullableNum(row.batchRows), batchDuplicates: nullableNum(row.batchDuplicates), batchUnresolved: nullableNum(row.batchUnresolved),
        events: num(row.events), observations: num(row.observations),
      })),
    },
    clientMonth: {
      entries: num(month.entries), thisAgreement: num(month.thisAgreement), otherAgreements: num(month.otherAgreements), noAgreementPlace: num(month.noAgreementPlace),
      unlinkedPlaces: list(month.unlinkedPlaces).map((row) => ({ place: str(row.place) || 'No place recorded', entries: num(row.entries) })),
    },
    exceptions: {
      futureDated: num(exceptions.futureDated),
      sparseYears: list(exceptions.sparseYears).map((row) => ({ year: num(row.year), entries: num(row.entries) })),
      supersededDuplicates: num(exceptions.supersededDuplicates),
    },
  };
}
