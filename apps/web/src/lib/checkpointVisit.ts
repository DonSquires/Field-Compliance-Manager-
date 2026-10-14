/**
 * Checkpoint visit helpers.
 *
 * Proximity, accuracy and duplicate adjudication are decided by the governed
 * RPC `record_patrol_checkpoint_visit`, which measures distance in PostGIS
 * against the stored checkpoint anchor. The client does not re-decide it.
 */

export type CheckpointVisitRecord = {
  checkpoint_id?: string | null;
  route_checkpoint_id?: string | null;
};

export function countCompletedCheckpoints(visits: CheckpointVisitRecord[]): number {
  return new Set(
    visits
      .map((visit) => visit.route_checkpoint_id ?? visit.checkpoint_id)
      .filter((checkpointId): checkpointId is string => Boolean(checkpointId))
  ).size;
}
