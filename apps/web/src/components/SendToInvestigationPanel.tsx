import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface OpenInvestigation {
  id: string;
  investigation_reference: string;
  title: string;
  status: string;
}

const TYPES = ['trespass', 'enforcement', 'compliance', 'incident', 'safety', 'biosecurity', 'noise', 'smoke', 'parking', 'welfare', 'other'];
const OPEN_STATUSES = ['open', 'active', 'awaiting_evidence', 'awaiting_review', 'referred', 'court'];

/**
 * Sends a sighting (and its canonical vehicle) to an investigation of the
 * organisation that recorded the sighting: a new investigation, or one that is
 * already open. Investigation RPCs require an administrator of that organisation.
 */
export const SendToInvestigationPanel: React.FC<{
  organizationId: string;
  observationId: string;
  vehicleId?: string | null;
  plate?: string | null;
  observedAt: string;
}> = ({ organizationId, observationId, vehicleId, plate, observedAt }) => {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [open, setOpen] = useState<OpenInvestigation[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [investigationId, setInvestigationId] = useState('');
  const [form, setForm] = useState({ reference: '', title: '', type: 'trespass', priority: 'medium', summary: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; label: string } | null>(null);

  // ATLAS CALLS: is_admin_for_org; ATLAS READS: investigations_summary
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const admin = await supabase.rpc('is_admin_for_org', { target_org_id: organizationId });
      if (cancelled) return;
      setIsAdmin(admin.data === true);
      if (admin.data !== true) return;
      const { data } = await supabase.from('investigations_summary')
        .select('id,investigation_reference,title,status')
        .eq('organization_id', organizationId).in('status', OPEN_STATUSES)
        .order('opened_at', { ascending: false }).limit(50);
      if (cancelled) return;
      const rows = (data ?? []) as OpenInvestigation[];
      setOpen(rows);
      if (rows.length === 0) setMode('new');
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  useEffect(() => {
    const day = new Date(observedAt);
    const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    setForm((current) => ({
      ...current,
      reference: current.reference || `INV-${plate ?? 'SIGHTING'}-${stamp}`,
      title: current.title || `Vehicle ${plate ?? ''} sighting ${day.toLocaleDateString('en-NZ')}`.replace(/\s+/g, ' '),
    }));
  }, [observedAt, plate]);

  if (isAdmin === null) return null;
  if (!isAdmin) return <p className="vehicle-profile-hint">Sending a sighting to an investigation requires an administrator of the organisation that recorded it.</p>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let targetId = investigationId;
    let label = open.find((item) => item.id === investigationId)?.investigation_reference ?? '';
    if (mode === 'new') {
      // ATLAS CALLS: create_investigation
      const { data, error: createError } = await supabase.rpc('create_investigation', {
        p_organization_id: organizationId,
        p_client_request_id: crypto.randomUUID(),
        p_reference: form.reference.trim(),
        p_title: form.title.trim(),
        p_investigation_type: form.type,
        p_priority: form.priority,
        p_summary: form.summary.trim() || null,
        p_lead_user_id: null,
      });
      if (createError || !data) { setError(createError?.message ?? 'The investigation was not confirmed.'); setBusy(false); return; }
      targetId = (data as { id: string }).id;
      label = form.reference.trim();
    }
    const linkReason = reason.trim() || 'Sent from vehicle observation history';
    // ATLAS CALLS: link_investigation_entity
    const observationLink = await supabase.rpc('link_investigation_entity', {
      p_investigation_id: targetId, p_entity_type: 'observation', p_entity_id: observationId,
      p_link_role: mode === 'new' ? 'primary' : 'supporting', p_link_reason: linkReason,
    });
    if (observationLink.error) { setError(`Investigation ${label} is ready but the sighting was not linked: ${observationLink.error.message}`); setBusy(false); return; }
    if (vehicleId) {
      const vehicleLink = await supabase.rpc('link_investigation_entity', {
        p_investigation_id: targetId, p_entity_type: 'vehicle', p_entity_id: vehicleId,
        p_link_role: 'context', p_link_reason: `Vehicle ${plate ?? ''} from sighting`.trim(),
      });
      if (vehicleLink.error) setError(`Sighting linked, but the vehicle was not: ${vehicleLink.error.message}`);
    }
    setDone({ id: targetId, label });
    setBusy(false);
  };

  if (done) {
    return <p role="status">Sighting linked to investigation {done.label}. <a href={`/admin/investigations?id=${done.id}`} target="_blank" rel="noreferrer">Open investigation</a></p>;
  }

  return (
    <form className="vehicle-owner__form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        <legend>Send to investigation</legend>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <div role="radiogroup" aria-label="Investigation" className="vehicle-owner__mode">
          <label><input type="radio" checked={mode === 'existing'} disabled={open.length === 0} onChange={() => setMode('existing')} /> Add to an open investigation{open.length === 0 ? ' (none open)' : ''}</label>
          <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New investigation</label>
        </div>
        {mode === 'existing' ? (
          <label>Investigation
            <select required value={investigationId} onChange={(event) => setInvestigationId(event.target.value)}>
              <option value="">Select investigation</option>
              {open.map((item) => <option key={item.id} value={item.id}>{item.investigation_reference} · {item.title} ({item.status.replace(/_/g, ' ')})</option>)}
            </select>
          </label>
        ) : (
          <div className="vehicle-profile-fields">
            <label>Reference<input required value={form.reference} maxLength={80} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></label>
            <label>Title<input required value={form.title} maxLength={200} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
            <label>Type<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {TYPES.map((type) => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}
            </select></label>
            <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
              {['low', 'medium', 'high', 'critical'].map((level) => <option key={level} value={level}>{level[0].toUpperCase() + level.slice(1)}</option>)}
            </select></label>
            <label>Summary<textarea value={form.summary} maxLength={2000} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
          </div>
        )}
        <label>Why is this sighting relevant?<textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="For example: vehicle seen at the gate the night of the break-in" /></label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={mode === 'existing' ? !investigationId : !form.reference.trim() || !form.title.trim()}>
          {busy ? 'Sending…' : mode === 'new' ? 'Create investigation and link sighting' : 'Link sighting'}
        </button>
      </fieldset>
    </form>
  );
};

export default SendToInvestigationPanel;
