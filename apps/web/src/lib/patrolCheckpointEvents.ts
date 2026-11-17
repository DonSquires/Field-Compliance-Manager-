export const PATROL_CHECKPOINT_RECORDED = 'fcm:patrol-checkpoint-recorded';
export const PATROL_CAPTURE_REQUESTED = 'fcm:patrol-capture-requested';

export function notifyPatrolCheckpointRecorded(shiftId: string): void {
  window.dispatchEvent(new CustomEvent(PATROL_CHECKPOINT_RECORDED, { detail: { shiftId } }));
}

export function requestPatrolCapture(shiftId: string): void {
  window.dispatchEvent(new CustomEvent(PATROL_CAPTURE_REQUESTED, { detail: { shiftId } }));
}
