import { useState, type FormEvent } from 'react';
import { localTermsErrors, monthsForSeasons, previewPlaceServiceChange, savePlaceServiceChange,
  type PlaceService, type PlaceServiceChangeInput, type PlaceServiceEndpoint, type PlaceServicePreview,
  type PlaceServiceTerms, type PlaceServicesWorkspace } from '../../lib/placeServices';
import { nzDateInput, nzDateTimeLabel } from '../../lib/nzDateTime';
import { plainWords } from '../../lib/rosterWords';

const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const monthLabels = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const toggle = (values: number[], value: number) => values.includes(value) ? values.filter(item => item !== value) : [...values, value].sort((a, b) => a - b);
const today = () => nzDateInput(new Date().toISOString()).slice(0, 10);

function initialTerms(workspace: PlaceServicesWorkspace): PlaceServiceTerms {
  const anchor = workspace.anchors[0];
  return {
    anchor: { site_id: anchor?.kind === 'site' ? anchor.id : null, zone_id: anchor?.kind === 'zone' ? anchor.id : null },
    module_key: workspace.modules.find(item => item.module_key !== 'static_guarding')?.module_key ?? '',
    days: { mode: 'fixed', weekdays: [1, 2, 3, 4, 5, 6, 7] }, window: { mode: 'any' },
    months: [], visits_per_shift: 1, min_gap_minutes: 60, dwell_minutes: 15, checks: [], officer_instructions: null,
  };
}

function Endpoint({ label, value, onChange }: { label: string; value: PlaceServiceEndpoint; onChange: (value: PlaceServiceEndpoint) => void }) {
  return <div className="place-service-endpoint">
    <label>{label}<select value={value.anchor} onChange={event => {
      const anchor = event.target.value;
      onChange(anchor === 'clock' ? { anchor: 'clock', time: '18:00' }
        : { anchor: anchor === 'sunrise' ? 'sunrise' : 'sunset', offset_hours: 0 });
    }}><option value="sunrise">Sunrise</option><option value="sunset">Sunset</option><option value="clock">Clock time</option></select></label>
    {value.anchor === 'clock'
      ? <label>{label} time<input type="time" required value={value.time} onChange={event => onChange({ anchor: 'clock', time: event.target.value })} /></label>
      : <label>{label} offset (hours)<input type="number" step="0.25" min="-12" max="12" value={value.offset_hours} onChange={event => onChange({ ...value, offset_hours: Number(event.target.value) })} /></label>}
  </div>;
}

export function PatrolScheduleEditor({ locationId, workspace, service, ending, moduleLabels, onCancel, onSaved }: {
  locationId: string; workspace: PlaceServicesWorkspace; service: PlaceService | null; ending: boolean;
  moduleLabels: Record<string, string>; onCancel: () => void; onSaved: (status: string) => void;
}) {
  const [terms, setTerms] = useState<PlaceServiceTerms>(() =>
    service?.terms && 'days' in service.terms ? service.terms : initialTerms(workspace));
  const [agreementId, setAgreementId] = useState(service?.service_agreement_id ?? workspace.agreements[0]?.id ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [preview, setPreview] = useState<PlaceServicePreview | null>(null);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<{ reason: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorId = terms.anchor.site_id ?? terms.anchor.zone_id ?? '';
  const anchor = workspace.anchors.find(item => item.id === anchorId);
  const errors = ending ? [] : localTermsErrors(terms, anchor?.has_point ?? false);
  const input: PlaceServiceChangeInput = {
    locationId, agreementId, deliveryScheduleId: service?.delivery_schedule_id ?? null,
    changeKind: ending ? 'end' : service ? 'update' : 'create', terms: ending ? null : terms, effectiveFrom,
  };
  async function getPreview(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try { setPreview(await previewPlaceServiceChange(input)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Preview failed'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || !reason.trim() || busy) return;
    const requestId = attempt?.reason === reason ? attempt.requestId : crypto.randomUUID();
    setAttempt({ reason, requestId });
    setError(null);
    setBusy(true);
    try {
      const result = await savePlaceServiceChange({ ...input, requestId, reason, previewFingerprint: preview.preview_fingerprint });
      onSaved(result.status);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed'); }
    finally { setBusy(false); }
  }
  const selectedDays = terms.days.mode === 'fixed' ? terms.days.weekdays : terms.days.allowed;
  return <section className="place-service-editor" aria-label={ending ? 'End patrol' : service ? 'Edit patrol' : 'Add patrol'}>
    <h3>{ending ? 'End patrol service' : service ? 'Edit patrol' : 'Add patrol'}</h3>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    {preview ? <div className="place-service-preview">
      <h4>Review change</h4>
      <p>Applies from {preview.applies_from}. {preview.needs_approval ? 'Another administrator must approve this.' : 'No second approval required.'}</p>
      <p>{preview.affected.length} unstarted shifts will be updated; {preview.blocked.length} protected shifts will keep their existing plan.</p>
      {preview.affected.length > 0 && <div>
        <h5>Shifts to update</h5>
        <ul>{preview.affected.map(item => <li key={item.shift_id}>
          {item.date} · {item.work_unit_name ?? 'Unnamed work unit'} · {nzDateTimeLabel(item.scheduled_start)} to {nzDateTimeLabel(item.scheduled_end)} · {plainWords(item.status)}
        </li>)}</ul>
      </div>}
      {preview.blocked.map(item => <p key={item.shift_id}>{item.date}: {item.reason}</p>)}
      {preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <div className="place-service-days" aria-label="Next four weeks">{preview.next_days.map(day => <span key={day.date}>
        {day.date}: {day.patrols === null ? 'Days not drawn yet' : `${day.patrols} visits`}{day.covered ? ' · rostered' : ' · not rostered'}
        {day.window_open && day.window_close ? ` · ${nzDateTimeLabel(day.window_open)} to ${nzDateTimeLabel(day.window_close)}` : ''}
      </span>)}</div>
      <label>Reason for change<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
      <footer><button type="button" disabled={busy} onClick={() => { setPreview(null); setAttempt(null); }}>Back</button>
        <button type="button" className="is-primary" disabled={busy || !reason.trim()} onClick={() => void confirm()}>{busy ? 'Saving…' : 'Confirm'}</button></footer>
    </div> : <form onSubmit={event => void getPreview(event)}>
      <label>Agreement<select value={agreementId} disabled={Boolean(service)} onChange={event => setAgreementId(event.target.value)}>
        {workspace.agreements.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      {!ending && <>
        <label>Place anchor<select value={anchorId ? `${terms.anchor.site_id ? 'site' : 'zone'}:${anchorId}` : ''} onChange={event => {
          const [kind, id] = event.target.value.split(':');
          setTerms({ ...terms, anchor: { site_id: kind === 'site' ? id : null, zone_id: kind === 'zone' ? id : null } });
        }}>{workspace.anchors.map(item => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{item.kind === 'site' ? 'Site' : 'Area'} · {item.name}</option>)}</select></label>
        <label>Specialty service<select value={terms.module_key} onChange={event => setTerms({ ...terms, module_key: event.target.value })}>
          {workspace.modules.filter(item => item.module_key !== 'static_guarding').map(item => <option key={item.module_key} value={item.module_key}>{moduleLabels[item.module_key] ?? item.module_key.replaceAll('_', ' ')}</option>)}</select></label>
        <fieldset><legend>Days</legend><label className="place-service-choice"><input type="radio" name="day-mode" checked={terms.days.mode === 'fixed'} onChange={() => setTerms({ ...terms, days: { mode: 'fixed', weekdays: selectedDays } })} />Fixed days</label>
          <label className="place-service-choice"><input type="radio" name="day-mode" checked={terms.days.mode === 'random'} onChange={() => setTerms({ ...terms, days: { mode: 'random', allowed: selectedDays, per_week: 1 } })} />Random days</label>
          <div className="place-service-choices">{dayLabels.map((label, index) => <label className="place-service-choice" key={label}><input type="checkbox" checked={selectedDays.includes(index + 1)} onChange={() => setTerms({ ...terms, days: terms.days.mode === 'fixed' ? { ...terms.days, weekdays: toggle(selectedDays, index + 1) } : { ...terms.days, allowed: toggle(selectedDays, index + 1) } })} />{label}</label>)}</div>
          {terms.days.mode === 'random' && <label>Random days per week<input type="number" min="1" max="7" required value={terms.days.per_week} onChange={event => setTerms({ ...terms, days: { mode: 'random', allowed: selectedDays, per_week: Number(event.target.value) } })} /></label>}
        </fieldset>
        <fieldset><legend>Time window</legend>
          {(['any', 'fixed', 'solar'] as const).map(mode => <label key={mode} className="place-service-choice"><input type="radio" name="window-mode" checked={terms.window.mode === mode} onChange={() => setTerms({ ...terms, window: mode === 'any' ? { mode } : mode === 'fixed' ? { mode, start: '22:00', end: '06:00' } : { mode, start: { anchor: 'sunset', offset_hours: 0 }, end: { anchor: 'sunrise', offset_hours: 0 } } })} />{mode === 'any' ? 'Any time' : mode === 'fixed' ? 'Between times' : 'Sunrise / sunset'}</label>)}
          {terms.window.mode === 'fixed' && <div className="place-manager-grid"><label>Start time<input type="time" required value={terms.window.start} onChange={event => setTerms({ ...terms, window: { mode: 'fixed', start: event.target.value, end: terms.window.mode === 'fixed' ? terms.window.end : '' } })} /></label><label>End time<input type="time" required value={terms.window.end} onChange={event => setTerms({ ...terms, window: { mode: 'fixed', start: terms.window.mode === 'fixed' ? terms.window.start : '', end: event.target.value } })} /></label></div>}
          {terms.window.mode === 'solar' && <><Endpoint label="Start" value={terms.window.start} onChange={start => setTerms({ ...terms, window: { mode: 'solar', start, end: terms.window.mode === 'solar' ? terms.window.end : { anchor: 'sunrise', offset_hours: 0 } } })} /><Endpoint label="End" value={terms.window.end} onChange={end => setTerms({ ...terms, window: { mode: 'solar', start: terms.window.mode === 'solar' ? terms.window.start : { anchor: 'sunset', offset_hours: 0 }, end } })} /></>}
        </fieldset>
        <fieldset><legend>Months</legend><p>No months selected means every month.</p><div className="place-service-choices">{workspace.seasons.map(season => {
          const seasonMonths = monthsForSeasons(workspace.seasons, [season.season_key]);
          const selected = seasonMonths.length > 0 && seasonMonths.every(month => terms.months.includes(month));
          return <button key={season.season_key} type="button" aria-pressed={selected} onClick={() => setTerms({ ...terms,
            months: selected ? terms.months.filter(month => !seasonMonths.includes(month)) : [...new Set([...terms.months, ...seasonMonths])].sort((a, b) => a - b),
          })}>{season.label}</button>;
        })}</div>
          <div className="place-service-choices">{monthLabels.map((month, index) => <label className="place-service-choice" key={month}><input type="checkbox" checked={terms.months.includes(index + 1)} onChange={() => setTerms({ ...terms, months: toggle(terms.months, index + 1) })} />{month}</label>)}</div></fieldset>
        <div className="place-manager-grid">
          <label>Visits per shift<input type="number" min="1" max="24" required value={terms.visits_per_shift} onChange={event => setTerms({ ...terms, visits_per_shift: Number(event.target.value) })} /></label>
          <label>Minimum gap (minutes)<input type="number" min="0" max="720" required value={terms.min_gap_minutes} onChange={event => setTerms({ ...terms, min_gap_minutes: Number(event.target.value) })} /></label>
          <label>Time on site (minutes)<input type="number" min="1" max="480" required value={terms.dwell_minutes} onChange={event => setTerms({ ...terms, dwell_minutes: Number(event.target.value) })} /></label>
        </div>
        <fieldset><legend>Checks</legend><div className="place-service-choices">{workspace.check_types.map(check => <label className="place-service-choice" key={check.check_key}><input type="checkbox" checked={terms.checks.includes(check.check_key)} onChange={() => setTerms({ ...terms, checks: terms.checks.includes(check.check_key) ? terms.checks.filter(key => key !== check.check_key) : [...terms.checks, check.check_key] })} />{check.label}</label>)}
          {terms.checks.filter(key => !workspace.check_types.some(check => check.check_key === key)).map(key => <label className="place-service-choice" key={key}><input type="checkbox" checked onChange={() => setTerms({ ...terms, checks: terms.checks.filter(item => item !== key) })} />{`${key.replaceAll('_', ' ')} (no longer offered — untick to remove)`}</label>)}</div></fieldset>
        <label>Officer instructions<textarea value={terms.officer_instructions ?? ''} onChange={event => setTerms({ ...terms, officer_instructions: event.target.value })} /></label>
      </>}
      <label>Effective from<input type="date" min={today()} required value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
      {errors.map(item => <p className="place-service-error" key={item}>{item}</p>)}
      <footer><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" className="is-primary" disabled={busy || errors.length > 0 || !agreementId || (!ending && (!anchorId || !terms.module_key))}>{busy ? 'Preparing preview…' : 'Preview'}</button></footer>
    </form>}
  </section>;
}
