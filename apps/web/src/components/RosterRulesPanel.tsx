import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './RosterRulesPanel.css';

interface FatigueRules {
  organization_id: string;
  min_rest_hours_between_shifts: number;
  max_hours_per_week: number;
  max_consecutive_days: number;
  enforced: boolean;
  updated_at: string;
}

const DEFAULTS = { rest: '10', week: '60', days: '6' };

/** The employing organisation's rest and hours rules: what the roster refuses, in the rosterer's words. */
export function RosterRulesPanel({ organizationId, organizationName }: { organizationId: string; organizationName?: string | null }) {
  const [rules, setRules] = useState<FatigueRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...DEFAULTS, enforced: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // ATLAS READS: organization_fatigue_rules (one row per employing organisation; none = the roster is not checking)
    const { data, error: readError } = await supabase.from('organization_fatigue_rules').select('organization_id, min_rest_hours_between_shifts, max_hours_per_week, max_consecutive_days, enforced, updated_at').eq('organization_id', organizationId).maybeSingle();
    if (readError) setError(readError.message);
    const row = (data as FatigueRules | null) ?? null;
    setRules(row);
    if (row) setForm({ rest: String(row.min_rest_hours_between_shifts), week: String(row.max_hours_per_week), days: String(row.max_consecutive_days), enforced: row.enforced });
    setLoading(false);
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    // ATLAS WRITES: manage_organization_fatigue_rules (administrators of the organisation; audited before/after)
    const { data, error: saveError } = await supabase.rpc('manage_organization_fatigue_rules', {
      p_organization_id: organizationId,
      p_min_rest_hours_between_shifts: Number(form.rest),
      p_max_hours_per_week: Number(form.week),
      p_max_consecutive_days: Number(form.days),
      p_enforced: form.enforced,
    });
    if (saveError || !data) setError(saveError?.message ?? 'The rules were not saved.');
    else {
      setRules(data as FatigueRules);
      setNotice(form.enforced ? 'Saved. From now on the roster refuses a shift that breaks these rules and says which one.' : 'Saved. The rules are recorded but the roster is not enforcing them.');
    }
    setSaving(false);
  };

  return (
    <section className="reports-section roster-rules" aria-labelledby="roster-rules-title">
      <h2 id="roster-rules-title">Rest &amp; hours rules</h2>
      <p className="subtitle">What the roster checks before it lets anyone roster {organizationName ? `${organizationName}'s` : 'your'} staff. Checked when a shift is created, edited, offered for coverage, or filled from a template.</p>
      {loading ? <p className="roster-rules-note">Checking the rules…</p> : (
        <>
          <p className={`roster-rules-state ${rules?.enforced ? 'is-on' : 'is-off'}`} role="status">
            {rules ? (rules.enforced ? <><ShieldCheck size={16} aria-hidden="true" /> Enforced: at least {rules.min_rest_hours_between_shifts} h rest between shifts, no more than {rules.max_hours_per_week} h in a Monday–Sunday week, no more than {rules.max_consecutive_days} days in a row. Last changed {new Date(rules.updated_at).toLocaleString('en-NZ')}.</> : <><AlertTriangle size={16} aria-hidden="true" /> Recorded but not enforced: the roster will accept shifts that break these rules.</>)
              : <><AlertTriangle size={16} aria-hidden="true" /> Not set. The roster is not checking rest or hours for anyone yet — it will accept a shift 2 hours after the last one ended.</>}
          </p>
          <form className="assessment-form roster-rules-form" onSubmit={save}>
            <div className="form-row">
              <div className="form-group"><label htmlFor="rules-rest">Minimum rest between shifts (hours)</label><input id="rules-rest" type="number" min="0" max="24" step="0.5" required value={form.rest} onChange={(event) => setForm({ ...form, rest: event.target.value })} /></div>
              <div className="form-group"><label htmlFor="rules-week">Most hours in a week</label><input id="rules-week" type="number" min="1" max="168" step="0.5" required value={form.week} onChange={(event) => setForm({ ...form, week: event.target.value })} /><small className="form-hint">Monday to Sunday, New Zealand time.</small></div>
              <div className="form-group"><label htmlFor="rules-days">Most days in a row</label><input id="rules-days" type="number" min="1" max="31" step="1" required value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value })} /></div>
            </div>
            <label className="roster-rules-enforce"><input type="checkbox" checked={form.enforced} onChange={(event) => setForm({ ...form, enforced: event.target.checked })} /><span><b>Refuse shifts that break these rules</b><small>Off records the rules for reference only. Either way the rosterer sees the officer's rest, hours and days in a row before creating a shift.</small></span></label>
            {error && <p className="roster-rules-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
            {notice && <p className="roster-rules-saved" role="status"><CheckCircle2 size={14} aria-hidden="true" /> {notice}</p>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : rules ? 'Save rules' : 'Set rules'}</button>
          </form>
        </>
      )}
    </section>
  );
}
