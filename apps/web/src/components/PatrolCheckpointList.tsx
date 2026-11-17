export interface PatrolCheckpoint {
  id: string;
  kind: 'route' | 'site';
  name: string;
  description?: string | null;
  qr_code?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  radius_meters?: number | null;
  sequence?: number;
  site_id?: string | null;
  zone_id?: string | null;
  required: boolean;
  visited: boolean;
  sequence_order: number | null;
  stop_ids: string[];
  auto_geofence_status: 'verified' | 'unverified' | 'missing_or_invalid_geofence' | 'unavailable_route';
}

export interface PatrolCheckpointVisit {
  id?: string;
  checkpoint_id?: string | null;
  route_checkpoint_id?: string | null;
  visited_at: string;
  scan_method?: string;
  notes?: string | null;
  gps_distance_from_checkpoint?: number | null;
  within_radius?: boolean | null;
  checkpoint_verification_at_visit?: string | null;
}

interface Props {
  checkpoints: PatrolCheckpoint[];
  visits: PatrolCheckpointVisit[];
  activeCheckpointId: string | null;
  notes: string;
  recording: boolean;
  onSelect: (id: string | null) => void;
  onNotesChange: (notes: string) => void;
  onRecord: (checkpoint: PatrolCheckpoint) => void;
  instanceId: string;
}

export function PatrolCheckpointList({ checkpoints, visits, activeCheckpointId, notes, recording, onSelect, onNotesChange, onRecord, instanceId }: Props) {
  return <div className="checkpoints-list">
    {checkpoints.map((checkpoint, index) => {
      const visit = visits.find((item) => checkpoint.kind === 'route'
        ? item.route_checkpoint_id === checkpoint.id : item.checkpoint_id === checkpoint.id);
      const selected = activeCheckpointId === checkpoint.id;
      return <div key={`${checkpoint.kind}:${checkpoint.id}`} className={`checkpoint-item ${visit ? 'completed' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0 }}>
            <div className="checkpoint-number">{checkpoint.sequence_order ?? index + 1}</div>
            <div>
              <h4 style={{ margin: 0, fontSize: '14px' }}>{checkpoint.name}</h4>
              <span>{checkpoint.required ? 'Required for patrol completion' : 'Optional'}</span>
              {!visit && checkpoint.auto_geofence_status !== 'verified' && <p>Automatic verification unavailable: {checkpoint.auto_geofence_status === 'unavailable_route'
                ? 'route checkpoint geofence has not been verified' : checkpoint.auto_geofence_status === 'unverified'
                  ? 'checkpoint geofence has not been verified' : 'checkpoint geofence is missing or invalid'}. Contact operations.</p>}
              {checkpoint.description && <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: 'var(--color-text-secondary)' }}>{checkpoint.description}</p>}
            </div>
          </div>
          {visit
            ? <span className="badge badge-success">✓ {visit.scan_method === 'gps' && visit.checkpoint_verification_at_visit === 'verified' && visit.within_radius === true ? 'Verified' : 'Visited'} {new Date(visit.visited_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            : <button className="btn btn-sm btn-secondary" aria-label={`${selected ? 'Cancel visit at' : 'Record Visit at'} ${checkpoint.name}`} disabled={recording} onClick={() => onSelect(selected ? null : checkpoint.id)}>{selected ? 'Cancel' : 'Record Visit'}</button>}
        </div>
        {selected && <div style={{ marginTop: '8px', padding: '10px', background: 'var(--color-bg-primary)', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
          <div className="form-group">
            <label style={{ fontSize: '11px' }} htmlFor={`checkpoint-notes-${instanceId}-${checkpoint.kind}-${checkpoint.id}`}>Officer Observations / Notes (Optional)</label>
            <input id={`checkpoint-notes-${instanceId}-${checkpoint.kind}-${checkpoint.id}`} type="text" placeholder="e.g. Site secure, gates locked, no unauthorized vehicles" value={notes} onChange={(event) => onNotesChange(event.target.value)} />
          </div>
          <p style={{ margin: '6px 0 0 0', fontSize: '11px', color: 'var(--color-text-secondary)' }}>
            {visit ? 'This visit is already recorded. Your draft notes were not saved; copy them to an observation report or cancel the draft.'
              : 'Your location is captured and checked against this checkpoint. You must be inside the checkpoint radius for the visit to be accepted.'}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            {!visit && <button className="btn btn-primary btn-sm" aria-label={`✓ Confirm & Record Visit at ${checkpoint.name}`} disabled={recording} onClick={() => onRecord(checkpoint)}>{recording ? 'Recording…' : '✓ Confirm & Record Visit'}</button>}
            <button className="btn btn-secondary btn-sm" aria-label={`Cancel visit draft at ${checkpoint.name}`} disabled={recording} onClick={() => onSelect(null)}>Cancel</button>
          </div>
        </div>}
        {visit?.notes && <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', paddingLeft: '32px' }}>Note: {visit.notes}</div>}
      </div>;
    })}
  </div>;
}
