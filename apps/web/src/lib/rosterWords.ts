/** Plain-words helpers for the roster surfaces. Statuses are stored as codes; people read sentences. */

const SLOT_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft \u2013 not sent yet',
  published: 'Waiting for officer',
  accepted: 'Accepted',
  declined: 'Declined \u2013 reassign',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Roster slot status code -> what the rosterer needs to know about it. */
export const slotStatusLabel = (status: string): string => SLOT_STATUS_LABELS[status] ?? status.replaceAll('_', ' ');

const SHIFT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled – not sent yet',
  published: 'Waiting for officer',
  accepted: 'Accepted',
  in_progress: 'On shift now',
  completed: 'Completed',
  declined: 'Declined – reassign',
  cancelled: 'Cancelled',
  missed: 'Missed – nobody attended',
};

/** Field shift status code -> what the rosterer sees on the board. */
export const shiftStatusLabel = (status: string): string => SHIFT_STATUS_LABELS[status] ?? plainWords(status);

/** `in_progress` -> `In progress`; null/empty -> the fallback. */
export const plainWords = (value: string | null | undefined, fallback = 'Not recorded'): string => {
  if (!value) return fallback;
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Commercial readiness codes that need no action from the rosterer. */
export const COMMERCIAL_READY_STATUSES = ['ready', 'accepted', 'verified', 'not_applicable', 'source_verified'];

/** Readiness code -> words; seeded spreadsheet jobs are R&M's verified source of record. */
export const commercialStatusLabel = (status: string | null | undefined): string =>
  status === 'source_verified' ? 'Verified by source records' : plainWords(status);

/** Readiness areas (`billing`, `cost centre`) still needing action for one slot's readiness row. */
export const commercialIssueAreas = (readiness: object): string[] =>
  Object.entries(readiness)
    .filter(([key, value]) => key.endsWith('_status') && !COMMERCIAL_READY_STATUSES.includes(String(value)))
    .map(([key]) => key.replace(/_status$/, '').replaceAll('_', ' '));

/** `21:00–01:00` in NZ local time, 24-hour so it fits a roster chip. */
export const timeRange = (start: string, end: string): string =>
  `${new Date(start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false })}\u2013${new Date(end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

/** `1 draft`, `3 drafts`. */
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const ISO_DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Contracted days (ISO 1 = Monday … 7 = Sunday; the week starts on Monday). None/all -> `every day`; runs -> `Mon–Fri`. */
export const contractedDaysWords = (days: number[] | null | undefined): string => {
  const set = Array.from(new Set((days ?? []).filter((day) => day >= 1 && day <= 7))).sort((left, right) => left - right);
  if (set.length === 0 || set.length === 7) return 'every day';
  const contiguous = set.every((day, index) => index === 0 || day === set[index - 1] + 1);
  if (contiguous && set.length >= 3) return `${ISO_DAY_SHORT[set[0]]}\u2013${ISO_DAY_SHORT[set[set.length - 1]]}`;
  return set.map((day) => ISO_DAY_SHORT[day]).join(', ');
};

/** Contracted hours. No window means the work can be required at any time of day (24-hour cover). */
export const contractedHoursWords = (start: string | null | undefined, end: string | null | undefined): string =>
  start ? `${start.slice(0, 5)}\u2013${end ? end.slice(0, 5) : 'end of shift'}` : 'any time of day (24-hour)';

/** `every day` -> `Every day` for a standalone label. */
export const sentenceCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const WORK_UNIT_TYPE_LABELS: Record<string, string> = { patrol: 'Patrol run', static: 'Static post', internal: 'Office / internal', workshop: 'Manufacturing & maintenance' };

/** Work unit type code -> the words used everywhere else in the app. */
export const workUnitTypeLabel = (type: string | null | undefined, fallback = 'Unknown'): string => (type ? WORK_UNIT_TYPE_LABELS[type] ?? plainWords(type) : fallback);
