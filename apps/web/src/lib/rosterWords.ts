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
};

/** Field shift status code -> what the rosterer sees on the board. */
export const shiftStatusLabel = (status: string): string => SHIFT_STATUS_LABELS[status] ?? plainWords(status);

/** `in_progress` -> `In progress`; null/empty -> the fallback. */
export const plainWords = (value: string | null | undefined, fallback = 'Not recorded'): string => {
  if (!value) return fallback;
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** `21:00–01:00` in NZ local time, 24-hour so it fits a roster chip. */
export const timeRange = (start: string, end: string): string =>
  `${new Date(start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false })}\u2013${new Date(end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

/** `1 draft`, `3 drafts`. */
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const WORK_UNIT_TYPE_LABELS: Record<string, string> = { patrol: 'Patrol run', static: 'Static post', internal: 'Office / internal' };

/** Work unit type code -> the words used everywhere else in the app. */
export const workUnitTypeLabel = (type: string | null | undefined, fallback = 'Unknown'): string => (type ? WORK_UNIT_TYPE_LABELS[type] ?? plainWords(type) : fallback);
