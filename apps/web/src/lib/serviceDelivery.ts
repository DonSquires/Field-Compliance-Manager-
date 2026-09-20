/** Delivered service at an agreement's places (get_agreement_service_delivery): shared types and plain words. */

export interface DeliveryPlace {
  location_id: string;
  place_name: string | null;
  place_kind: 'site' | 'zone';
  patrol_expected: number;
  patrol_completed: number;
  patrol_missed: number;
  patrol_late: number;
  post_expected: number;
  post_attended: number;
  post_minutes: number;
  last_presence_at: string | null;
  shift_count: number;
}

export interface DeliveryResponses {
  count: number;
  attended: number;
  within_target: number;
  over_target: number;
  still_open: number;
  median_minutes_to_scene: number | null;
  slowest_minutes_to_scene: number | null;
  by_type: Record<string, number>;
}

export interface DeliverySummary {
  agreement_id: string;
  period_start: string;
  period_end: string;
  places: DeliveryPlace[];
  totals: { patrol_expected: number; patrol_completed: number; patrol_missed: number; patrol_late: number; post_expected: number; post_attended: number; post_minutes: number; place_count: number };
  /** Dispatch jobs raised under the agreement; absent from summaries produced before 20260920040000. */
  responses?: DeliveryResponses;
}

export type DeliveryPeriod = 'this_month' | 'last_month';

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Calendar month bounds the reader thinks in; the server caps 'this month' at today. */
export const deliveryPeriodBounds = (period: DeliveryPeriod, now = new Date()) => {
  const offset = period === 'last_month' ? -1 : 0;
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { start: localDate(start), end: localDate(end) };
};

export const hoursOnPost = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One sentence per place, in the reader's words. */
export const deliveryWords = (place: DeliveryPlace): { patrol: string | null; post: string | null; presence: string } => {
  const patrol = place.patrol_expected === 0 ? null
    : `${place.patrol_completed} of ${plural(place.patrol_expected, 'contracted visit')} done${place.patrol_missed ? ` · ${plural(place.patrol_missed, 'missed visit')}` : ''}${place.patrol_late ? ` · ${place.patrol_late} late` : ''}`;
  const post = place.post_expected === 0 ? null
    : `${plural(place.post_attended, 'guard attendance')} of ${place.post_expected} rostered · ${hoursOnPost(place.post_minutes)} on post`;
  const presence = place.last_presence_at
    ? `Last on site ${new Date(place.last_presence_at).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'No presence recorded in this period';
  return { patrol, post, presence };
};

/** Something is owed and not yet delivered: a missed visit, or a rostered post nobody attended. */
export const deliveryHasGaps = (summary: DeliverySummary): boolean =>
  summary.totals.patrol_missed > 0 || summary.totals.post_attended < summary.totals.post_expected;

const JOB_TYPE_WORDS: Record<string, string> = { alarm_response: 'alarm', incident: 'incident', noise_control: 'noise complaint', welfare_check: 'welfare check', patrol_support: 'patrol support call', event: 'event call' };
const jobTypeWords = (type: string, count: number) => { const word = JOB_TYPE_WORDS[type] ?? type.replaceAll('_', ' '); return `${count} ${word}${count === 1 ? '' : 's'}`; };

/** One sentence on how the provider responded to what was raised under the agreement, or null when the summary predates the responses block. */
export const responseWords = (summary: DeliverySummary): { tone: 'ok' | 'warn' | 'none'; text: string } | null => {
  const r = summary.responses;
  if (!r) return null;
  if (r.count === 0) return { tone: 'none', text: 'No alarms or incidents were raised under this agreement in this period.' };
  const raised = Object.entries(r.by_type).sort((a, b) => b[1] - a[1]).map(([type, count]) => jobTypeWords(type, count)).join(', ');
  const timing = r.attended > 0 ? ` · ${r.within_target} of ${r.attended} attended inside the response target${r.median_minutes_to_scene !== null ? `, typically ${r.median_minutes_to_scene} min from the alarm or call to on scene` : ''}${r.slowest_minutes_to_scene !== null && r.attended > 1 ? ` (slowest ${r.slowest_minutes_to_scene} min)` : ''}` : '';
  const open = r.still_open > 0 ? ` · ${r.still_open} not attended yet` : '';
  return { tone: r.over_target > 0 || r.still_open > 0 ? 'warn' : 'ok', text: `${raised} raised${timing}${open}.` };
};

/** The RPC returns one jsonb object; anything else (an empty array from a stub, null) is not a summary. */
export const asDeliverySummary = (data: unknown): DeliverySummary | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as Partial<DeliverySummary>;
  return Array.isArray(candidate.places) && candidate.totals && typeof candidate.totals === 'object' ? (candidate as DeliverySummary) : null;
};
