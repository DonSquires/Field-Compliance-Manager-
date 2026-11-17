import { useEffect, useMemo, useState } from 'react';
import {
  fetchLocationPatrolSetup, previewLocationPatrolSetup, ratesApplicableToRun, saveLocationPatrolSetup,
  type LocationPatrolSetup, type PatrolSetupChanges, type PatrolSetupPreview, type PlaceService,
} from '../../lib/placeServices';
import { nzDateInput, nzDateTimeLabel } from '../../lib/nzDateTime';

type Source = 'agreement' | 'existing' | 'new';
const today = () => nzDateInput(new Date().toISOString()).slice(0, 10);
const money = (amount: number) => `$${amount.toFixed(2)}`;

export function ResponsibleRunDialog({ locationId, service, onClose, onSaved }: {
  locationId: string; service: PlaceService; onClose: () => void; onSaved: () => void;
}) {
  const [setup, setSetup] = useState<LocationPatrolSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unitKey, setUnitKey] = useState('');
  const [unitCode, setUnitCode] = useState('hourly_officer');
  const [source, setSource] = useState<Source>('agreement');
  const [ruleId, setRuleId] = useState('');
  const [newRate, setNewRate] = useState({ name: '', amount: '' });
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [preview, setPreview] = useState<PatrolSetupPreview | null>(null);
  const [attempt, setAttempt] = useState<{ payload: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchLocationPatrolSetup(locationId)
      .then(data => { if (current) setSetup(data); })
      .catch(cause => { if (current) setLoadError(cause instanceof Error ? cause.message : 'The patrol setup could not be loaded'); });
    return () => { current = false; };
  }, [locationId]);

  const config = setup?.configs.find(item => item.contractual_terms?.id === service.delivery_schedule_id) ?? null;
  const runs = useMemo(() => (setup?.runs ?? []).filter(run => run.is_active && run.organization_id === config?.organization_id), [setup, config]);
  const units = (setup?.billing_units ?? []).filter(unit => unit.active);
  const billingUnit = units.find(unit => unit.code === unitCode) ?? null;
  const rateType = billingUnit?.rate_type ?? '';
  const billing = setup?.billing_workspaces.find(item => item.provider_id === config?.provider_organization_id) ?? null;
  const agreement = billing?.agreements.find(item => item.id === config?.service_agreement_id) ?? null;
  const agreementAllowed = rateType === 'hourly' && Number(agreement?.base_rate_per_hour ?? 0) > 0;
  const rates = ratesApplicableToRun(billing, config, rateType, effectiveFrom);
  const selection = billing?.selections.find(item => item.service_agreement_location_id === config?.service_agreement_location_id
    && item.service_agreement_module_id === config?.service_agreement_module_id && item.rate_type === rateType) ?? null;
  const effectiveSource: Source = source === 'agreement' && !agreementAllowed ? (rates.length ? 'existing' : 'new') : source;
  const effectiveRuleId = effectiveSource === 'existing' && rates.some(rate => rate.id === ruleId) ? ruleId : rates[0]?.id ?? '';

  useEffect(() => {
    const current = config?.responsibilities.find(item => !item.superseded_at && !item.effective_to);
    if (current && !unitKey) setUnitKey(`${current.patrol_route_id}:${current.work_unit_id}`);
  }, [config, unitKey]);

  const amount = Number(newRate.amount);
  const [routeId, workUnitId] = unitKey.split(':');
  const changes: PatrolSetupChanges | null = config && routeId && workUnitId && billingUnit && (
    effectiveSource === 'agreement' || (effectiveSource === 'existing' && effectiveRuleId)
    || (effectiveSource === 'new' && newRate.name.trim() && Number.isFinite(amount) && amount > 0)) ? {
      patrol_config_id: config.id,
      service_agreement_location_id: config.service_agreement_location_id,
      service_agreement_module_id: config.service_agreement_module_id,
      patrol_route_id: routeId,
      work_unit_id: workUnitId,
      effective_from: effectiveFrom,
      billing: {
        source: effectiveSource === 'agreement' ? 'agreement' : 'rate_rule',
        rate_type: rateType,
        billing_unit_code: billingUnit.code,
        rate_rule_id: effectiveSource === 'existing' ? effectiveRuleId : null,
        new_rate: effectiveSource === 'new' ? { name: newRate.name.trim(), amount } : null,
        expected_selection_id: selection?.id ?? null,
        expected_updated_at: selection?.updated_at ?? null,
      },
    } : null;
  const payload = changes ? JSON.stringify(changes) : '';
  const freshPreview = preview && attempt?.payload === payload ? preview : null;

  async function runPreview() {
    if (!changes || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await previewLocationPatrolSetup(locationId, changes);
      setAttempt(current => current?.payload === payload ? current : { payload, requestId: crypto.randomUUID() });
      setPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be previewed'); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!changes || !freshPreview || !attempt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveLocationPatrolSetup({ locationId, requestId: attempt.requestId, expectedVersion: freshPreview.version,
        previewFingerprint: freshPreview.preview_fingerprint, changes });
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The responsible run could not be saved'); }
    finally { setBusy(false); }
  }

  const close = <div className="place-service-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button></div>;
  if (loadError) return <section className="place-service-editor" aria-label="Responsible run">
    <h3>Responsible run</h3><p role="alert" className="place-service-error">{loadError}</p>{close}</section>;
  if (!setup) return <section className="place-service-editor" aria-label="Responsible run"><p role="status">Loading patrol setup…</p></section>;
  if (!config) return <section className="place-service-editor" aria-label="Responsible run">
    <h3>Responsible run</h3><p>This patrol has no operational setup yet. Save the patrol schedule first, then choose a run.</p>{close}</section>;

  return <section className="place-service-editor" aria-label="Responsible run">
    <h3>Responsible run</h3>
    <p>Choose the patrol work unit that completes this patrol, and how the client is charged for it.</p>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    {!runs.length && <p>No active patrol run exists in the operating branch. Create a patrol run and work unit first.</p>}
    <label>Responsible work unit<select value={unitKey} onChange={event => setUnitKey(event.target.value)}>
      <option value="">Choose a work unit</option>
      {runs.map(run => <optgroup key={run.id} label={run.name}>
        {run.work_units.map(unit => <option key={unit.id} value={`${run.id}:${unit.id}`}>{unit.name}</option>)}
      </optgroup>)}
    </select></label>
    <label>Charging basis<select value={unitCode} onChange={event => setUnitCode(event.target.value)}>
      {units.map(unit => <option key={unit.code} value={unit.code}>{unit.label}</option>)}
    </select></label>
    <fieldset>
      <legend>Rate</legend>
      <label className="place-service-choice"><input type="radio" name="billing-source" checked={effectiveSource === 'agreement'}
        disabled={!agreementAllowed} onChange={() => setSource('agreement')} />Agreement's standard rate</label>
      {agreementAllowed ? <p>{money(Number(agreement?.base_rate_per_hour))} per hour from the agreement.</p>
        : <p>The agreement has no standard rate for this charging basis.</p>}
      <label className="place-service-choice"><input type="radio" name="billing-source" checked={effectiveSource === 'existing'}
        disabled={!rates.length} onChange={() => setSource('existing')} />Existing charge rate</label>
      {effectiveSource === 'existing' && <label>Charge rate<select value={effectiveRuleId} onChange={event => setRuleId(event.target.value)}>
        {rates.map(rate => <option key={rate.id} value={rate.id}>{`${rate.name} (${money(Number(rate.amount))})`}</option>)}
      </select></label>}
      <label className="place-service-choice"><input type="radio" name="billing-source" checked={effectiveSource === 'new'}
        onChange={() => setSource('new')} />Create a charge rate</label>
      {effectiveSource === 'new' && <div className="place-service-choices">
        <label>Rate name<input value={newRate.name} maxLength={120} onChange={event => setNewRate({ ...newRate, name: event.target.value })} /></label>
        <label>Amount ({agreement?.currency ?? 'NZD'})<input type="number" min="0.01" step="0.01" value={newRate.amount}
          onChange={event => setNewRate({ ...newRate, amount: event.target.value })} /></label>
      </div>}
    </fieldset>
    <label>Applies from<input type="date" min={today()} value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
    {freshPreview && <div role="status" className="place-service-pending">
      <span>{freshPreview.affected.length
        ? `${freshPreview.affected.length} future shift${freshPreview.affected.length === 1 ? '' : 's'} will be replanned.`
        : 'No future shifts need replanning.'}</span>
      {!!freshPreview.blocked.length && <ul>{freshPreview.blocked.map(item => <li key={item.shift_id}>
        Kept unchanged: {nzDateTimeLabel(item.scheduled_start)} · {item.reason}</li>)}</ul>}
    </div>}
    <div className="place-service-actions">
      {freshPreview
        ? <button type="button" className="is-primary" onClick={() => void confirm()} disabled={busy}>Confirm responsible run</button>
        : <button type="button" className="is-primary" onClick={() => void runPreview()} disabled={busy || !changes}>Preview change</button>}
      <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </section>;
}
