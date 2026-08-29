export type ShiftStopStatus =
  | 'pending'
  | 'en_route'
  | 'on_scene'
  | 'completed'
  | 'skipped'
  | 'cancelled';

export function shiftStopStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending',
    en_route: 'En Route',
    on_scene: 'On Scene',
    completed: 'Completed',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
  };

  return labels[status] ?? status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
