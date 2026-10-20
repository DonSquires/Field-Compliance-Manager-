import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './RecordFollowUp.css';

export interface ObservationAnnotation {
  observation_id: string;
  vehicle_flagged: boolean;
  hs_concern: boolean;
  hazard_classes: string[] | null;
  notice_issued: boolean;
  prior_notice_count: number;
  follow_up_open: boolean;
  update_count: number;
}

/** Loads flag / notice / H&S / follow-up indicators for observations the caller can read. */
export function useObservationAnnotations(observationIds: string[]) {
  const [annotations, setAnnotations] = useState<Record<string, ObservationAnnotation>>({});
  const key = observationIds.join(',');

  // ATLAS CALLS: get_observation_annotations
  const reload = useCallback(async () => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) { setAnnotations({}); return; }
    const { data, error } = await supabase.rpc('get_observation_annotations', { p_observation_ids: ids.slice(0, 200) });
    if (error) return;
    setAnnotations(Object.fromEntries((Array.isArray(data) ? data as ObservationAnnotation[] : []).map((row) => [row.observation_id, row])));
  }, [key]);

  useEffect(() => { void reload(); }, [reload]);
  return { annotations, reload };
}

export const ObservationIndicators: React.FC<{ annotation?: ObservationAnnotation }> = ({ annotation }) => {
  if (!annotation) return <span className="observation-indicators" aria-label="No status indicators">—</span>;
  const badges: Array<[string, string, string]> = [];
  if (annotation.vehicle_flagged) badges.push(['Flagged', 'badge-warning', 'Vehicle or person has an active of-interest flag in your organisation']);
  if (annotation.hs_concern) badges.push(['H&S', 'badge-danger', annotation.hazard_classes?.length ? `Health and safety: ${annotation.hazard_classes.join(', ').replace(/_/g, ' ')}` : 'Health and safety concern recorded']);
  if (annotation.notice_issued) badges.push(['Notice issued', 'badge-danger', 'A notice was issued from this observation']);
  if (annotation.prior_notice_count > 0) badges.push([`${annotation.prior_notice_count} prior notice${annotation.prior_notice_count === 1 ? '' : 's'}`, 'badge-warning', 'Notices issued for this vehicle before this observation']);
  if (annotation.follow_up_open) badges.push(['Follow-up open', 'badge-warning', 'A follow-up was requested and is not yet marked done']);
  if (annotation.update_count > 0) badges.push([`${annotation.update_count} update${annotation.update_count === 1 ? '' : 's'}`, 'badge-info', 'Updates added after the original record']);
  if (badges.length === 0) return <span className="observation-indicators">—</span>;
  return (
    <span className="observation-indicators">
      {badges.map(([label, tone, title]) => <span key={label} className={`badge ${tone}`} title={title}>{label}</span>)}
    </span>
  );
};
