// Reads the frozen month-end activity report written by public.build_agreement_activity_report
// (monthly_report_packs.data.activityReport and .activity_lines). Labelling mirrors
// supabase/functions/_shared/report-activity-sections.mjs so the review screen and the PDF agree.

export const ACTIVITY_REPORT_VERSION = 1;

type Json = Record<string, unknown>;

export interface ActivityCount { code: string; entries: number; hours: number; km: number; photos: number }
export interface ActivityPlace { place: string; entries: number; hours: number; km: number; photos: number; categories: Record<string, number> }
export interface ActivitySpecies { code: string; culls: number; sightings: number; other: number; total: number }
export interface ActivityAmmunition { calibre: string; entries: number; rounds: number | null }
export interface ActivityWork { entries: number; hours: number; km: number; bySubject: ActivityCount[]; completed: number; open: number }
export interface ActivityModule { module: string; entries: number; withPhoto: number; photos: number }

export interface ActivityReport {
  basis: string;
  totals: {
    entries: number; events: number; observations: number; workOrders: number; patrolVisits: number;
    cameraActivations: number; unattributedEntries: number; places: number; travelKm: number; hours: number; photos: number;
  };
  categories: ActivityCount[];
  byPlace: ActivityPlace[];
  pest: { entries: number; hours: number; km: number; bySpecies: ActivitySpecies[]; byActivity: ActivityCount[]; byEquipment: ActivityCount[]; ammunition: ActivityAmmunition[] };
  maintenance: ActivityWork;
  manufacture: ActivityWork;
  observations: { total: number; withPhoto: number; photos: number; eventPhotos: number; byModule: ActivityModule[] };
  accountedFor: {
    eventsInScope: number; mirrorEventsExcluded: number; activityEvents: number; observationsInScope: number;
    workOrdersInScope: number; entries: number; itemised: number; notItemised: number; unclassified: number; reconciled: boolean;
  };
  labels: Record<string, Record<string, string>>;
}

export interface ActivityLine {
  date: string;
  place: string;
  kind: 'event' | 'observation' | 'work_order' | string;
  category: string;
  activity: string;
  subject: string;
  species: string;
  equipment: string;
  job: string;
  km: number;
  hours: number;
  photos: number;
  materials: Array<{ type: string; calibre: string; quantity: number | null }>;
  workOrderStatus: string;
}

const object = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object).filter((item): item is Json => item !== null) : []);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const count = (row: Json): ActivityCount => ({ code: str(row.code), entries: num(row.entries), hours: num(row.hours), km: num(row.km), photos: num(row.photos) });

function work(value: unknown): ActivityWork {
  const row = object(value) ?? {};
  const orders = object(row.workOrders) ?? {};
  return { entries: num(row.entries), hours: num(row.hours), km: num(row.km), bySubject: list(row.bySubject).map(count), completed: num(orders.completed), open: num(orders.open) };
}

export function humaniseCode(code: string): string {
  const value = code.replaceAll('_', ' ').trim();
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

export function readActivityReport(data: unknown): ActivityReport | null {
  const report = object(object(data)?.activityReport);
  const totals = object(report?.totals);
  if (!report || report.version !== ACTIVITY_REPORT_VERSION || !totals) return null;
  const pest = object(report.pestControl) ?? {};
  const observations = object(report.observations) ?? {};
  const accounted = object(report.accountedFor) ?? {};
  const labels: Record<string, Record<string, string>> = {};
  for (const [dim, map] of Object.entries(object(report.labels) ?? {})) {
    labels[dim] = Object.fromEntries(Object.entries(object(map) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
  return {
    basis: str(report.basis),
    totals: {
      entries: num(totals.entries), events: num(totals.events), observations: num(totals.observations), workOrders: num(totals.workOrders),
      patrolVisits: num(totals.patrolVisits), cameraActivations: num(totals.cameraActivations), unattributedEntries: num(totals.unattributedEntries),
      places: num(totals.places), travelKm: num(totals.travelKm), hours: num(totals.hours), photos: num(totals.photos),
    },
    categories: list(report.categories).map(count),
    byPlace: list(report.byPlace).map((row) => ({
      place: str(row.place) || 'Not place-specific', entries: num(row.entries), hours: num(row.hours), km: num(row.km), photos: num(row.photos),
      categories: Object.fromEntries(Object.entries(object(row.categories) ?? {}).map(([code, value]) => [code, num(value)])),
    })),
    pest: {
      entries: num(pest.entries), hours: num(pest.hours), km: num(pest.km),
      bySpecies: list(pest.bySpecies).map((row) => ({ code: str(row.code), culls: num(row.culls), sightings: num(row.sightings), other: num(row.other), total: num(row.total) })),
      byActivity: list(pest.byActivity).map(count),
      byEquipment: list(pest.byEquipment).map(count),
      ammunition: list(pest.ammunition).map((row) => ({ calibre: str(row.calibre), entries: num(row.entries), rounds: typeof row.rounds === 'number' ? row.rounds : null })),
    },
    maintenance: work(report.maintenance),
    manufacture: work(report.manufacture),
    observations: {
      total: num(observations.total), withPhoto: num(observations.withPhoto), photos: num(observations.photos), eventPhotos: num(observations.eventPhotos),
      byModule: list(observations.byModule).map((row) => ({ module: str(row.module), entries: num(row.entries), withPhoto: num(row.withPhoto), photos: num(row.photos) })),
    },
    accountedFor: {
      eventsInScope: num(accounted.eventsInScope), mirrorEventsExcluded: num(accounted.mirrorEventsExcluded), activityEvents: num(accounted.activityEvents),
      observationsInScope: num(accounted.observationsInScope), workOrdersInScope: num(accounted.workOrdersInScope), entries: num(accounted.entries),
      itemised: num(accounted.itemised), notItemised: num(accounted.notItemised), unclassified: num(accounted.unclassified), reconciled: accounted.reconciled === true,
    },
    labels,
  };
}

export function activityLabel(report: Pick<ActivityReport, 'labels'>, dim: string, code: string): string {
  if (!code) return '';
  const label = report.labels[dim]?.[code];
  if (label) return label;
  if (dim === 'serviceLine' && code === 'none') return 'No source category';
  if (dim === 'module' && code === 'unknown') return 'Not specified';
  return humaniseCode(code);
}

export function readActivityLines(value: unknown): { lines: ActivityLine[]; notItemised: number } | null {
  const document = object(value);
  if (!document || document.version !== ACTIVITY_REPORT_VERSION) return null;
  return {
    notItemised: num(document.notItemised),
    lines: list(document.lines).map((line) => ({
      date: str(line.d), place: str(line.p) || 'Not place-specific', kind: str(line.k), category: str(line.c),
      activity: str(line.a), subject: str(line.s), species: str(line.sp), equipment: str(line.eq), job: str(line.j),
      km: num(line.km), hours: num(line.h), photos: num(line.ph), workOrderStatus: str(line.ws),
      materials: list(line.m).map((item) => ({ type: str(item.t), calibre: str(item.cal), quantity: typeof item.q === 'number' ? item.q : null })),
    })),
  };
}

const formats = new Map<number, Intl.NumberFormat>();
export function formatActivityNumber(value: number, digits = 0): string {
  if (!formats.has(digits)) formats.set(digits, new Intl.NumberFormat('en-NZ', { maximumFractionDigits: digits }));
  return formats.get(digits)!.format(value);
}

export function activityLineDetail(report: Pick<ActivityReport, 'labels'>, line: ActivityLine): string {
  const materials = line.materials.map((item) => {
    const calibre = item.calibre && item.calibre !== 'unspecified' ? ` ${item.calibre}` : '';
    const quantity = item.quantity === null ? '' : ` × ${formatActivityNumber(item.quantity, 2)}`;
    return `${activityLabel(report, 'material', item.type)}${calibre}${quantity}`;
  });
  return [
    line.kind === 'observation' ? 'Observation' : '',
    line.kind === 'work_order' ? `Work order ${line.workOrderStatus.replaceAll('_', ' ')}`.trim() : '',
    activityLabel(report, 'activity', line.activity),
    activityLabel(report, 'subject', line.subject),
    activityLabel(report, 'species', line.species),
    activityLabel(report, 'equipment', line.equipment),
    ...materials,
    line.photos > 0 ? `${formatActivityNumber(line.photos)} photo${line.photos === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') || '—';
}

export function formatNzDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
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
  if (!result || result.version !== ACTIVITY_REPORT_VERSION) return null;
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
