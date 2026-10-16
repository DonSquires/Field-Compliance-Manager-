/**
 * PlaceHazardRegister — the house's hazard register for administrators: officer reports awaiting review first,
 * then live hazards critical first. Every change bumps the hazard version, so officers re-confirm their briefing.
 * Reads get_place_hazard_register; writes only through manage_place_hazard.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { HAZARD_CLASSES, hazardClassLabel, openHazardSource, RISK_LABELS, type RiskLevel } from '../lib/safetyBriefing';
import './PlaceHazardRegister.css';

export interface RegisterHazard {
  id: string; organization_id: string; organization_name: string; location_id: string; client_site_id: string | null; zone_id: string | null;
  place_name: string; title: string; hazard_class: string; risk_level: RiskLevel; controls: string[]; details: string | null;
  source_document_id: string | null; source_document_name: string | null; source_name: string | null; source_locator: string | null; source_as_of: string | null;
  origin: 'bob_extracted' | 'officer_reported' | 'manual'; status: 'reported' | 'active' | 'retired'; version: number; review_due: string | null;
  reported_by_name: string | null; reviewed_at: string | null; retired_reason: string | null; updated_at: string; can_manage: boolean;
}

interface PlaceOption { key: string; label: string; siteId: string | null; zoneId: string | null }
interface Draft { placeKey: string; title: string; hazardClass: string; riskLevel: RiskLevel; controls: string; details: string; sourceName: string; sourceLocator: string; reviewDue: string }

const ORIGIN_LABEL: Record<RegisterHazard['origin'], string> = { bob_extracted: 'From a document (Bob, approved)', officer_reported: 'Reported by an officer', manual: 'Added by an administrator' };
const emptyDraft = (placeKey: string): Draft => ({ placeKey, title: '', hazardClass: 'other', riskLevel: 'medium', controls: '', details: '', sourceName: '', sourceLocator: '', reviewDue: '' });

interface Props {
  organizationId: string;
  locationId: string;
  site: { id: string; name: string };
  zones: Array<{ id: string; name: string }>;
}

export function PlaceHazardRegister({ organizationId, locationId, site, zones }: Props) {
  const [hazards, setHazards] = useState<RegisterHazard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [retiring, setRetiring] = useState<{ id: string; reason: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const createRequestId = useRef(crypto.randomUUID());

  const places: PlaceOption[] = [
    { key: `site:${site.id}`, label: site.name, siteId: site.id, zoneId: null },
    ...zones.map((zone) => ({ key: `zone:${zone.id}`, label: `Zone: ${zone.name}`, siteId: null, zoneId: zone.id })),
    { key: 'house', label: 'Whole location (every site and zone here)', siteId: null, zoneId: null },
  ];

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // ATLAS READS: get_place_hazard_register
    const { data, error: rpcError } = await supabase.rpc('get_place_hazard_register', { p_location_id: locationId, p_include_retired: false });
    if (rpcError) setError(rpcError.message);
    else setHazards((data as RegisterHazard[] | null) ?? []);
    setLoading(false);
  }, [locationId]);

  useEffect(() => { void load(); }, [load]);

  const manage = async (action: 'create' | 'update' | 'confirm' | 'retire', hazardId: string | null, fields: Record<string, unknown>, requestId: string | null, success: string) => {
    setSaving(true); setError(null); setNotice(null);
    // ATLAS WRITES: manage_place_hazard (audited; update/confirm bump the version so officers re-acknowledge)
    const { error: rpcError } = await supabase.rpc('manage_place_hazard', { p_action: action, p_hazard_id: hazardId, p_fields: fields, p_client_request_id: requestId });
    setSaving(false);
    if (rpcError) { setError(rpcError.message); return false; }
    setNotice(success);
    await load();
    return true;
  };

  const placeKeyOf = (hazard: RegisterHazard) => hazard.client_site_id ? `site:${hazard.client_site_id}` : hazard.zone_id ? `zone:${hazard.zone_id}` : 'house';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { draft } = editing;
    const fields: Record<string, unknown> = {
      title: draft.title, hazard_class: draft.hazardClass, risk_level: draft.riskLevel,
      controls: draft.controls.split('\n').map((line) => line.trim()).filter(Boolean),
      details: draft.details, source_name: draft.sourceName, source_locator: draft.sourceLocator, review_due: draft.reviewDue || null,
    };
    if (editing.id) {
      if (await manage('update', editing.id, fields, null, 'Hazard updated. Officers on shift will be asked to confirm the change.')) setEditing(null);
      return;
    }
    const place = places.find((option) => option.key === draft.placeKey) ?? places[0];
    const created = await manage('create', null, { ...fields, organization_id: organizationId, location_id: locationId, client_site_id: place.siteId, zone_id: place.zoneId }, createRequestId.current, 'Hazard added to the register and to officer briefings.');
    if (created) { createRequestId.current = crypto.randomUUID(); setEditing(null); }
  };

  const openSource = async (hazardId: string) => {
    const result = await openHazardSource(hazardId);
    if (!result.opened) setError(result.message ?? 'The source document could not be opened.');
  };

  const awaiting = hazards.filter((hazard) => hazard.status === 'reported').length;

  return (
    <section className="place-hazard-register" aria-labelledby="place-hazard-register-title">
      <header>
        <div>
          <span className="place-hazard-kicker"><ShieldAlert size={14} aria-hidden="true" /> Hazard register</span>
          <h3 id="place-hazard-register-title">Risks officers are briefed on here</h3>
          <p>{hazards.length === 0 ? 'No hazards recorded for this location.' : `${hazards.length} live ${hazards.length === 1 ? 'hazard' : 'hazards'}${awaiting ? ` · ${awaiting} reported by officers awaiting review` : ''}.`} Ask Bob to extract hazards from an H&amp;S document; his proposals arrive for approval.</p>
        </div>
        <div className="place-hazard-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh hazard register"><RefreshCw size={14} className={loading ? 'is-spinning' : ''} /></button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ id: null, draft: emptyDraft(places[0].key) })} disabled={Boolean(editing)}><Plus size={14} aria-hidden="true" /> Add hazard</button>
        </div>
      </header>

      {error && <p className="place-hazard-message is-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
      {notice && <p className="place-hazard-message is-success" role="status"><CheckCircle2 size={14} aria-hidden="true" /> {notice}</p>}

      {editing && (
        <form className="place-hazard-form" onSubmit={(event) => void save(event)}>
          <h4>{editing.id ? 'Edit hazard' : 'New hazard'}</h4>
          {!editing.id && (
            <label><span>Where</span>
              <select value={editing.draft.placeKey} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, placeKey: event.target.value } })}>
                {places.map((place) => <option key={place.key} value={place.key}>{place.label}</option>)}
              </select>
            </label>
          )}
          <label><span>Hazard (short, officer-readable)</span><input value={editing.draft.title} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, title: event.target.value } })} maxLength={200} required /></label>
          <div className="place-hazard-form-row">
            <label><span>Type</span><select value={editing.draft.hazardClass} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, hazardClass: event.target.value } })}>{HAZARD_CLASSES.map((value) => <option key={value} value={value}>{hazardClassLabel(value)}</option>)}</select></label>
            <label><span>Risk</span><select value={editing.draft.riskLevel} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, riskLevel: event.target.value as RiskLevel } })}>{(['critical', 'high', 'medium', 'low'] as RiskLevel[]).map((value) => <option key={value} value={value}>{RISK_LABELS[value]}</option>)}</select></label>
            <label><span>Review by</span><input type="date" value={editing.draft.reviewDue} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, reviewDue: event.target.value } })} /></label>
          </div>
          <label><span>Controls — what officers must do, one per line</span><textarea rows={3} value={editing.draft.controls} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, controls: event.target.value } })} /></label>
          <label><span>Details</span><textarea rows={2} value={editing.draft.details} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, details: event.target.value } })} /></label>
          <div className="place-hazard-form-row">
            <label><span>Source document name</span><input value={editing.draft.sourceName} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, sourceName: event.target.value } })} placeholder="e.g. Site H&S management plan" /></label>
            <label><span>Section or page</span><input value={editing.draft.sourceLocator} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, sourceLocator: event.target.value } })} placeholder="e.g. Section 4.2, p. 7" /></label>
          </div>
          <div className="place-hazard-form-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>{saving ? 'Saving…' : editing.id ? 'Save changes' : 'Add hazard'}</button>
          </div>
        </form>
      )}

      {loading && hazards.length === 0 ? <p className="place-hazard-subtle">Loading the hazard register…</p> : (
        <ul className="place-hazard-list">
          {hazards.map((hazard) => (
            <li key={hazard.id} className={`place-hazard-row is-${hazard.risk_level} ${hazard.status === 'reported' ? 'is-reported' : ''}`}>
              <div className="place-hazard-row-head">
                <span className={`place-hazard-risk is-${hazard.risk_level}`}>{RISK_LABELS[hazard.risk_level]}</span>
                <strong>{hazard.title}</strong>
                {hazard.status === 'reported' && <span className="place-hazard-badge">Awaiting review</span>}
              </div>
              <small>{hazardClassLabel(hazard.hazard_class)} · {hazard.place_name} · {ORIGIN_LABEL[hazard.origin]}{hazard.reported_by_name ? ` (${hazard.reported_by_name})` : ''} · v{hazard.version}{hazard.review_due ? ` · review by ${hazard.review_due}` : ''}</small>
              {hazard.controls.length > 0 && <ul className="place-hazard-controls">{hazard.controls.map((control) => <li key={control}>{control}</li>)}</ul>}
              {hazard.details && <p>{hazard.details}</p>}
              {(hazard.source_name || hazard.source_document_name) && (
                <small className="place-hazard-source">Source: {[hazard.source_name ?? hazard.source_document_name, hazard.source_locator].filter(Boolean).join(' · ')}
                  {hazard.source_document_id && <button type="button" className="btn btn-sm btn-link" onClick={() => void openSource(hazard.id)}><FileText size={13} aria-hidden="true" /> Open</button>}
                </small>
              )}
              {hazard.can_manage && (
                <div className="place-hazard-row-actions">
                  {hazard.status === 'reported' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void manage('confirm', hazard.id, {}, null, 'Hazard confirmed and kept in officer briefings.')}><CheckCircle2 size={13} aria-hidden="true" /> Confirm</button>}
                  <button type="button" className="btn btn-sm btn-secondary" disabled={saving || Boolean(editing)} onClick={() => setEditing({ id: hazard.id, draft: { placeKey: placeKeyOf(hazard), title: hazard.title, hazardClass: hazard.hazard_class, riskLevel: hazard.risk_level, controls: hazard.controls.join('\n'), details: hazard.details ?? '', sourceName: hazard.source_name ?? '', sourceLocator: hazard.source_locator ?? '', reviewDue: hazard.review_due ?? '' } })}><Pencil size={13} aria-hidden="true" /> Edit</button>
                  <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => setRetiring({ id: hazard.id, reason: '' })}><Trash2 size={13} aria-hidden="true" /> Retire</button>
                </div>
              )}
              {retiring?.id === hazard.id && (
                <form className="place-hazard-retire" onSubmit={(event) => { event.preventDefault(); void manage('retire', hazard.id, { reason: retiring.reason }, null, 'Hazard retired; it no longer appears in officer briefings.').then((ok) => { if (ok) setRetiring(null); }); }}>
                  <label><span>Why is this hazard no longer present?</span><input value={retiring.reason} onChange={(event) => setRetiring({ ...retiring, reason: event.target.value })} minLength={3} required placeholder="e.g. Scaffolding removed 12 Oct" /></label>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setRetiring(null)}>Cancel</button>
                  <button type="submit" className="btn btn-sm btn-danger" disabled={saving}>Retire hazard</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
