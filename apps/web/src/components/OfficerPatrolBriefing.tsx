import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Briefing {
  shift_id: string;
  stop_id: string;
  officer_instructions: string | null;
  access_instructions: string | null;
  hs_notes: string | null;
  privacy: { status: 'checked' | 'partly_withheld' | 'unavailable'; message?: string };
}

function isBriefing(value: unknown, shiftId: string, stopId: string): value is Briefing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (!data.privacy || typeof data.privacy !== 'object' || Array.isArray(data.privacy)) return false;
  const privacy = data.privacy as Record<string, unknown>;
  return data.shift_id === shiftId && data.stop_id === stopId
    && ['checked', 'partly_withheld', 'unavailable'].includes(String(privacy.status))
    && (privacy.message === undefined || typeof privacy.message === 'string')
    && ['officer_instructions', 'access_instructions', 'hs_notes'].every((key) => data[key] === null || typeof data[key] === 'string')
    && (privacy.status !== 'unavailable' || [data.officer_instructions, data.access_instructions, data.hs_notes].every((field) => field === null));
}

export function OfficerPatrolBriefing({ shiftId, stopId }: {
  shiftId: string;
  stopId: string;
}) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setBriefing(null);
    void supabase.functions.invoke('officer-patrol-stop-briefing', { body: { shift_id: shiftId, stop_id: stopId } }).then(({ data, error: failure }) => {
      if (!active) return;
      if (failure || !isBriefing(data, shiftId, stopId)) {
        console.error('Patrol stop briefing could not be confirmed:', failure ?? 'invalid response');
        setError('The private stop briefing could not be confirmed. Retry or contact operations.');
      } else {
        setBriefing(data);
      }
    }).catch((failure) => {
      console.error('Patrol stop briefing request failed:', failure);
      if (active) setError('The private stop briefing could not be loaded. Retry or contact operations.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [shiftId, stopId, attempt]);

  if (loading) return <p role="status">Loading the private stop briefing...</p>;
  if (error || briefing?.privacy.status === 'unavailable') return <div role="alert">
    <p>{error ?? briefing?.privacy.message ?? 'The stop briefing is withheld. Contact operations.'}</p>
    <button className="btn btn-secondary" type="button" onClick={retry}>Retry stop briefing</button>
  </div>;
  if (!briefing) return null;
  return <div className="patrol-stop-brief">
    {briefing.privacy.status === 'partly_withheld' && <div role="alert">
      <p>Some briefing details are withheld. Contact operations before relying on this information. Recording arrival is not safety clearance.</p>
      <button className="btn btn-secondary" type="button" onClick={retry}>Retry stop briefing</button>
    </div>}
    {briefing.officer_instructions && <p><strong>Do here:</strong> {briefing.officer_instructions}</p>}
    {briefing.access_instructions && <p><strong>Access:</strong> {briefing.access_instructions}</p>}
    {briefing.hs_notes && <p className="is-safety"><strong>Safety:</strong> {briefing.hs_notes}</p>}
    {!briefing.officer_instructions && !briefing.access_instructions && !briefing.hs_notes && briefing.privacy.status === 'checked'
      && <p>No briefing text supplied. This is not safety clearance.</p>}
  </div>;
}
