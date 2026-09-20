/**
 * ZoneScheduleEditor — when a zone's rules are in force, edited by a person in plain words.
 * Writes only through manage_zone_active_schedule (version check + audit on the server).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ALWAYS_ACTIVE, MONTH_SHORT, parseZoneSchedule, zoneScheduleArgs, zoneScheduleProblem, zoneScheduleWords, type ZoneSchedule } from '../lib/zoneSchedule';
import './ZoneScheduleEditor.css';

const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_LONG = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface SavedZone { id: string; active_schedule: Record<string, unknown> | null; configuration_version: number }

export function ZoneScheduleEditor({ zone, moduleLabel, onSaved }: {
  zone: { id: string; active_schedule: Record<string, unknown> | null; configuration_version: number };
  moduleLabel: string;
  onSaved: (zone: SavedZone) => void;
}) {
  const stored = parseZoneSchedule(zone.active_schedule);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ZoneSchedule>(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => { setDraft(parseZoneSchedule(zone.active_schedule)); setEditing(false); setError(null); }, [zone.id, zone.configuration_version]);

  const toggle = (key: 'days' | 'months', value: number) =>
    setDraft((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value].sort((a, b) => a - b) }));
  const problem = zoneScheduleProblem(draft);

  const save = async () => {
    if (problem) { setError(problem); return; }
    setSaving(true); setError(null); setReceipt(null);
    // ATLAS WRITES: manage_zone_active_schedule (location_zones.active_schedule + configuration_version, audit_log)
    const { data, error: saveError } = await supabase.rpc('manage_zone_active_schedule', { p_zone_id: zone.id, p_expected_version: zone.configuration_version, ...zoneScheduleArgs(draft) });
    if (saveError || !data) { setError(saveError?.message ?? 'The schedule was not saved.'); setSaving(false); return; }
    const saved = data as SavedZone;
    const words = zoneScheduleWords(parseZoneSchedule(saved.active_schedule));
    setReceipt(words === 'Always active' ? `Saved: the zone is always active (version ${saved.configuration_version}).` : `Saved: ${words} (version ${saved.configuration_version}). Outside this schedule the zone does not trigger ${moduleLabel} and officers cannot pick it by hand.`);
    setSaving(false); setEditing(false);
    onSaved(saved);
  };

  return <section className="zone-schedule" aria-label="Zone active schedule">
    <header>
      <div><span className="zone-schedule-kicker"><CalendarClock size={14} aria-hidden="true" /> Active schedule</span><strong>{zoneScheduleWords(stored)}</strong><small>{zoneScheduleWords(stored) === 'Always active' ? `The zone triggers ${moduleLabel} at any time on any day.` : `Outside these times the zone does not trigger ${moduleLabel}; scans there resolve as not active.`}</small></div>
      {!editing && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDraft(stored); setReceipt(null); setEditing(true); }}>Edit schedule</button>}
    </header>
    {receipt && <p className="zone-schedule-message is-success" role="status"><CheckCircle2 size={15} aria-hidden="true" />{receipt}</p>}
    {error && <p className="zone-schedule-message is-error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{error}</p>}
    {editing && <form className="zone-schedule-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="Edit active schedule">
      <fieldset><legend>Days (week starts Monday)</legend>
        <div className="zone-schedule-toggles">{[1, 2, 3, 4, 5, 6, 7].map((day) => <label key={day} className={draft.days.includes(day) ? 'is-on' : ''}><input type="checkbox" checked={draft.days.includes(day)} onChange={() => toggle('days', day)} aria-label={DAY_LONG[day]} />{DAY_SHORT[day]}</label>)}</div>
        <div className="zone-schedule-quick"><button type="button" onClick={() => setDraft({ ...draft, days: [1, 2, 3, 4, 5, 6, 7] })}>Every day</button><button type="button" onClick={() => setDraft({ ...draft, days: [1, 2, 3, 4, 5] })}>Weekdays</button><button type="button" onClick={() => setDraft({ ...draft, days: [6, 7] })}>Weekends</button></div>
      </fieldset>
      <fieldset><legend>Hours</legend>
        <div className="zone-schedule-times"><label><span>From</span><input type="time" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} /></label><label><span>Until</span><input type="time" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} /></label><button type="button" onClick={() => setDraft({ ...draft, start: '', end: '' })} disabled={!draft.start && !draft.end}>Any time of day</button></div>
        <small>Leave both empty for 24-hour cover. An end time earlier than the start runs overnight (for example 22:00 until 06:00).</small>
      </fieldset>
      <fieldset><legend>Months (for seasonal rules)</legend>
        <div className="zone-schedule-toggles is-months">{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <label key={month} className={draft.months.includes(month) ? 'is-on' : ''}><input type="checkbox" checked={draft.months.includes(month)} onChange={() => toggle('months', month)} aria-label={MONTH_LONG[month]} />{MONTH_SHORT[month]}</label>)}</div>
        <small>{draft.months.length === 0 || draft.months.length === 12 ? 'No months selected: the schedule applies all year.' : 'Only the selected months apply; the zone is inactive in the others.'}</small>
      </fieldset>
      <p className="zone-schedule-preview" aria-live="polite"><strong>This zone will be:</strong> {zoneScheduleWords(draft)}{problem ? ` — ${problem}` : ''}</p>
      <div className="zone-schedule-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDraft(ALWAYS_ACTIVE); }}>Reset to always active</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(false); setDraft(stored); setError(null); }} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving || Boolean(problem)}>{saving ? 'Saving…' : 'Save schedule'}</button>
      </div>
    </form>}
  </section>;
}
