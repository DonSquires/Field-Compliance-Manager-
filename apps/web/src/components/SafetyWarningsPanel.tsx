/**
 * SafetyWarningsPanel.tsx
 *
 * Platform-wide health-and-safety warnings for one vehicle, person, place,
 * site or zone. Reads through get_safety_warnings (redacted across
 * organisations), raises through raise_entity_flag, resolves through
 * resolve_entity_flag. Never reads entity_flags directly, so what another
 * organisation sees is exactly what the RPC returns.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  SAFETY_ALERT_LEVELS,
  SAFETY_HAZARD_CLASSES,
  alertLevelLabel,
  buildRaiseSafetyWarningArgs,
  describeWarningSource,
  hazardClassLabel,
  highestAlertLevel,
  safetyWarningTone,
  warningContactPath,
  type SafetyAlertLevel,
  type SafetyEntityType,
  type SafetyWarning,
} from '../lib/safetyWarnings';
import './SafetyWarningsPanel.css';

interface SafetyWarningsPanelProps {
  entityType: SafetyEntityType;
  entityId: string | null;
  /** Short label used in the copy, e.g. "this vehicle" or "this site". */
  entityLabel?: string;
  /** Hide the raise form (read-only surfaces). */
  canRaise?: boolean;
}

const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

export const SafetyWarningsPanel: React.FC<SafetyWarningsPanelProps> = ({ entityType, entityId, entityLabel = 'this record', canRaise = true }) => {
  const [warnings, setWarnings] = useState<SafetyWarning[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<{ hazardClass: string; alertLevel: SafetyAlertLevel; note: string }>({ hazardClass: 'violence_or_aggression', alertLevel: 'high', note: '' });

  const load = useCallback(async () => {
    if (!entityId) {
      setWarnings([]);
      return;
    }
    setLoading(true);
    setError(null);
    // ATLAS CALLS: get_safety_warnings (redacted, platform-wide)
    const { data, error: rpcError } = await supabase.rpc('get_safety_warnings', { p_entity_type: entityType, p_entity_ids: [entityId] });
    if (rpcError) {
      setError(rpcError.message);
      setWarnings([]);
    } else {
      setWarnings((data as SafetyWarning[] | null) ?? []);
    }
    setLoading(false);
  }, [entityId, entityType]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRaise = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!entityId) return;
    setError(null);
    setNotice(null);
    try {
      const args = buildRaiseSafetyWarningArgs({ entityType, entityId, hazardClass: form.hazardClass, alertLevel: form.alertLevel, note: form.note }, newRequestId());
      setSaving(true);
      // ATLAS CALLS: raise_entity_flag (governed write, idempotent, audited)
      const { error: rpcError } = await supabase.rpc('raise_entity_flag', args);
      if (rpcError) throw new Error(rpcError.message);
      setShowForm(false);
      setForm({ hazardClass: 'violence_or_aggression', alertLevel: 'high', note: '' });
      setNotice('Safety warning raised. Every organisation on the platform now sees the hazard, severity and your contact path; your note stays inside your organisation.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The safety warning could not be raised.');
    } finally {
      setSaving(false);
    }
  };

  const handleResolve = async (warning: SafetyWarning) => {
    setError(null);
    setNotice(null);
    // ATLAS CALLS: resolve_entity_flag (raiser or raising organisation's admin)
    const { error: rpcError } = await supabase.rpc('resolve_entity_flag', { p_flag_id: warning.id, p_note: null });
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice('Safety warning resolved. It is no longer shown to any organisation.');
    await load();
  };

  const worst = highestAlertLevel(warnings);

  return (
    <section className={`safety-warnings ${worst ? `safety-warnings--${safetyWarningTone(worst)}` : ''}`} aria-live="polite" data-testid="safety-warnings">
      <div className="safety-warnings__header">
        <div>
          <h3>Safety warnings {entityId && !loading ? `(${warnings.length})` : ''}</h3>
          <p className="safety-warnings__lede">
            Health-and-safety hazards recorded by any organisation on the platform for {entityLabel}. Other organisations see the hazard, severity and who to contact — never the notes.
          </p>
        </div>
        {canRaise && entityId && (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowForm((value) => !value)} disabled={saving}>
            {showForm ? 'Cancel' : 'Raise a safety warning'}
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>
          {error}
        </div>
      )}
      {notice && <p className="safety-warnings__notice" role="status">{notice}</p>}

      {showForm && canRaise && entityId && (
        <form className="assessment-form safety-warnings__form" onSubmit={handleRaise}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="safety-hazard-class">What is the hazard?</label>
              <select id="safety-hazard-class" value={form.hazardClass} onChange={(event) => setForm({ ...form, hazardClass: event.target.value })}>
                {SAFETY_HAZARD_CLASSES.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
              <small className="safety-warnings__hint">{SAFETY_HAZARD_CLASSES.find((entry) => entry.value === form.hazardClass)?.hint}</small>
            </div>
            <div className="form-group">
              <label htmlFor="safety-alert-level">How serious?</label>
              <select id="safety-alert-level" value={form.alertLevel} onChange={(event) => setForm({ ...form, alertLevel: event.target.value as SafetyAlertLevel })}>
                {SAFETY_ALERT_LEVELS.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="safety-note">What should staff expect? (stays inside your organisation)</label>
            <textarea id="safety-note" rows={2} required value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="e.g. Occupant threatened the last two officers who approached — attend in pairs." />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Raising…' : 'Confirm safety warning'}</button>
        </form>
      )}

      {!entityId ? (
        <p className="safety-warnings__empty">Safety warnings attach to a known vehicle, person or place. None can be recorded until {entityLabel} is on the register.</p>
      ) : loading ? (
        <p className="safety-warnings__empty">Checking safety warnings…</p>
      ) : warnings.length === 0 ? (
        <p className="safety-warnings__empty">No active safety warnings from any organisation.</p>
      ) : (
        <ul className="safety-warnings__list">
          {warnings.map((warning) => {
            const contact = warningContactPath(warning);
            return (
              <li key={warning.id} className={`safety-warning safety-warning--${safetyWarningTone(warning.alert_level)}`}>
                <div className="safety-warning__title">
                  <span className={`badge badge-${safetyWarningTone(warning.alert_level)}`}>{alertLevelLabel(warning.alert_level)}</span>
                  <strong>{hazardClassLabel(warning.hazard_class)}</strong>
                </div>
                <p className="safety-warning__source">
                  {describeWarningSource(warning)} · {new Date(warning.raised_at).toLocaleDateString('en-NZ')}
                  {warning.is_own_organization && warning.reason ? ` — ${warning.reason}` : ''}
                </p>
                {!warning.is_own_organization && (
                  <p className="safety-warning__contact">
                    {contact.length > 0 ? (
                      <>Contact {warning.organization_name ?? 'the raising organisation'} before attending: {contact.map((value, index) => (
                        <span key={value}>{index > 0 ? ' · ' : ''}{value.includes('@') ? <a href={`mailto:${value}`}>{value}</a> : <a href={`tel:${value.replace(/\s+/g, '')}`}>{value}</a>}</span>
                      ))}</>
                    ) : (
                      <>The raising organisation has not published a contact path — ask your supervisor to reach them before attending.</>
                    )}
                  </p>
                )}
                {warning.is_own_organization && canRaise && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleResolve(warning)}>Mark resolved</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default SafetyWarningsPanel;
