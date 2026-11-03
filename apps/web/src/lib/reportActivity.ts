// Reads the frozen client month-end activity report written by public.build_agreement_activity_report
// (monthly_report_packs.data.activityReport and .activity_lines). Labels, entry wording, the routine
// patrol fold and the site-log grouping mirror supabase/functions/_shared/report-activity-sections.mjs
// so the provider review shows exactly what the client receives in the PDF.

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
  accountedFor: {
    eventsInScope: number; mirrorEventsExcluded: number; activityEvents: number; observationsInScope: number;
    workOrdersInScope: number; incidentsInScope: number; entries: number; reported: number; operationalWithheld: number;
    withheldTravelAdmin: number; withheldShiftMarkers: number; itemised: number; notItemised: number; unclassified: number; reconciled: boolean;
  };
  labels: Record<string, Record<string, string>>;
}

export interface ReportPhotoRef { bucket: string; path: string }

export interface ActivityLine {
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

export interface SiteLogGroup { place: string; lines: ActivityLine[]; entries: ActivityLine[]; routine: ActivityLine[] }

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
  return {
    basis: str(report.basis),
    totals: {
      entries: num(totals.entries), events: num(totals.events), observations: num(totals.observations), workOrders: num(totals.workOrders),
      incidents: num(totals.incidents), patrolVisits: num(totals.patrolVisits), cameraActivations: num(totals.cameraActivations),
      withNotes: num(totals.withNotes), places: num(totals.places), photos: num(totals.photos),
    },
    categories: list(report.categories).map(count),
    byPlace: list(report.byPlace).map((row) => ({
      place: str(row.place) || NO_PLACE_LABEL, entries: num(row.entries), photos: num(row.photos),
      categories: Object.fromEntries(Object.entries(object(row.categories) ?? {}).map(([key, value]) => [key, num(value)])),
    })),
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
    accountedFor: {
      eventsInScope: num(accounted.eventsInScope), mirrorEventsExcluded: num(accounted.mirrorEventsExcluded), activityEvents: num(accounted.activityEvents),
      observationsInScope: num(accounted.observationsInScope), workOrdersInScope: num(accounted.workOrdersInScope), incidentsInScope: num(accounted.incidentsInScope),
      entries: num(accounted.entries), reported: num(accounted.reported), operationalWithheld: num(accounted.operationalWithheld),
      withheldTravelAdmin: num(accounted.withheldTravelAdmin), withheldShiftMarkers: num(accounted.withheldShiftMarkers),
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

function dayList(dates: string[]): string {
  const byMonth = new Map<string, number[]>();
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

/** Site-log grouping as in the PDF: incidents excluded (they have their own section), locations A-Z, "Not location-specific" last. */
export function siteLogGroups(lines: ActivityLine[]): SiteLogGroup[] {
  const byPlace = new Map<string, ActivityLine[]>();
  for (const line of lines) {
    if (line.kind === 'incident') continue;
    byPlace.set(line.place, [...(byPlace.get(line.place) ?? []), line]);
  }
  return [...byPlace.keys()]
    .sort((left, right) => (left === NO_PLACE_LABEL ? 1 : 0) - (right === NO_PLACE_LABEL ? 1 : 0) || left.localeCompare(right))
    .map((place) => {
      const placeLines = byPlace.get(place) ?? [];
      return { place, lines: placeLines, entries: placeLines.filter((line) => !isRoutineLine(line)), routine: placeLines.filter(isRoutineLine) };
    });
}

export function routineSummary(routine: ActivityLine[]): string {
  return `${countedText(routine.length, 'routine patrol', 'routine patrols')} with nothing further to report (${dayList(routine.map((line) => line.date))}).`;
}

export const SUMMARY_PHOTO_LIMIT = 6;
export const OF_NOTE_LIMIT = 20;

/** An observation, CCTV activation or anything photographed; incidents are listed separately and routine patrols only counted. */
export function isNotableLine(line: ActivityLine): boolean {
  if (line.kind === 'incident' || isRoutineLine(line)) return false;
  return line.kind === 'observation' || line.category === 'camera_activation' || line.photos > 0;
}

const noteRank = (line: ActivityLine) => (line.kind === 'incident' ? 0 : line.category === 'camera_activation' ? 1 : line.kind === 'observation' ? 2 : 3);
const joinList = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const shortDate = (value: string) => {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])} ${MONTHS[Number(match[1]) - 1]}` : value;
};

/** The notable entries listed under Of Note: most important first when capped, then back in date order. */
export function ofNoteLines(lines: ActivityLine[]): { listed: ActivityLine[]; total: number } {
  const notable = lines.filter(isNotableLine);
  const listed = notable
    .map((line, index) => ({ line, index }))
    .sort((left, right) => noteRank(left.line) - noteRank(right.line) || left.index - right.index)
    .slice(0, OF_NOTE_LIMIT)
    .sort((left, right) => left.index - right.index)
    .map(({ line }) => line);
  return { listed, total: notable.length };
}

/** Summary photos: one per entry in order of importance before any entry gets a second. */
export function summaryPhotos(report: Pick<ActivityReport, 'labels'>, lines: ActivityLine[]): Array<{ ref: ReportPhotoRef; caption: string }> {
  const ranked = lines
    .filter((line) => line.kind === 'incident' || isNotableLine(line))
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.photoRefs.length > 0)
    .sort((left, right) => noteRank(left.line) - noteRank(right.line) || left.index - right.index);
  const picks: Array<{ ref: ReportPhotoRef; caption: string }> = [];
  const seen = new Set<string>();
  for (let round = 0; picks.length < SUMMARY_PHOTO_LIMIT; round += 1) {
    if (!ranked.some(({ line }) => line.photoRefs.length > round)) break;
    for (const { line } of ranked) {
      const ref = line.photoRefs[round];
      const key = ref ? `${ref.bucket}/${ref.path}` : '';
      if (!ref || seen.has(key) || picks.length >= SUMMARY_PHOTO_LIMIT) continue;
      seen.add(key);
      const what = line.kind === 'incident' ? activityLabel(report, 'incidentType', line.incidentType) || 'Incident' : activityLabel(report, 'category', line.category);
      picks.push({ ref, caption: [shortDate(line.date), line.place, what].filter(Boolean).join(' · ') });
    }
  }
  return picks;
}

/** The period in plain sentences, built only from the frozen figures. */
export function summaryParagraphs(report: ActivityReport, lines: ActivityLine[]): string[] {
  const { totals, incidents, observations } = report;
  const hunters = report.hunterReturns;
  const hunterText = hunters && hunters.returns > 0
    ? `Permit holders submitted ${countedText(hunters.returns, 'hunter return', 'hunter returns')} reporting ${countedText(hunters.animals, 'animal', 'animals')}.`
    : '';
  if (totals.entries === 0) return ['Nothing was recorded at your locations during the period.', hunterText].filter(Boolean);
  const paragraphs: string[] = [];
  const top = report.byPlace.filter((row) => row.place && row.place !== NO_PLACE_LABEL).sort((left, right) => right.entries - left.entries)[0];
  paragraphs.push(`${countedText(totals.entries, 'entry was', 'entries were')} recorded across ${countedText(totals.places, 'location', 'locations')} during the period.`
    + (top && totals.places > 1 ? ` The most active location was ${top.place} with ${countedText(top.entries, 'entry', 'entries')}.` : ''));
  const culls = report.pest.bySpecies.reduce((sum, row) => sum + row.culls, 0);
  const work = [
    totals.patrolVisits > 0 ? countedText(totals.patrolVisits, 'patrol or site check', 'patrols and site checks') : '',
    totals.cameraActivations > 0 ? countedText(totals.cameraActivations, 'CCTV activation', 'CCTV activations') : '',
    culls > 0 ? countedText(culls, 'pest cull', 'pest culls') : '',
    report.maintenance.entries > 0 ? countedText(report.maintenance.entries, 'maintenance entry', 'maintenance entries') : '',
  ].filter(Boolean);
  if (work.length || hunterText) paragraphs.push([work.length ? `Work included ${joinList(work)}.` : '', hunterText].filter(Boolean).join(' '));
  const serious = incidents.bySeverity.filter((row) => row.code === 'high' || row.code === 'critical').reduce((sum, row) => sum + row.entries, 0);
  const incidentText = incidents.total > 0
    ? `${countedText(incidents.total, 'incident was', 'incidents were')} recorded${serious > 0 ? `, ${formatActivityNumber(serious)} of high or critical severity` : ''}.`
    : 'No incidents were recorded.';
  const observationText = observations.total > 0
    ? ` ${countedText(observations.total, 'observation was', 'observations were')} logged, ${formatActivityNumber(observations.withPhoto)} with photos.`
    : '';
  const noteText = lines.filter(isNotableLine).length + incidents.total > 0 ? ' The entries that stand out are listed under Of Note.' : '';
  paragraphs.push(`${incidentText}${observationText}${noteText}`);
  return paragraphs;
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
