import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { fuelMedianStatus } from '../lib/fuelPriceFreshness';
import { supabase } from '../lib/supabase';
import './FuelPriceMedianPanel.css';

type FuelType = 'petrol' | 'diesel' | 'lpg' | 'other';

interface FuelObservation {
  id: string;
  fuel_type: FuelType;
  observed_on: string;
  price_per_litre: number;
  source_name: string;
  source_url: string;
  source_published_at: string | null;
}
interface FuelPriceSource { id: string; name: string; source_url: string; fuel_type: FuelType; refresh_guidance: string | null; }

interface MedianFuelPrice {
  fuel_type: FuelType;
  median_price_per_litre: number | null;
  observation_count: number;
  window_start: string;
  window_end: string;
  latest_observed_on: string | null;
  source_names: string[] | null;
  source_urls: string[] | null;
}

const FUEL_LABELS: Record<FuelType, string> = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  lpg: 'LPG',
  other: 'Other fuel',
};

const requestId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const moneyPerLitre = (value: number | null | undefined): string => value == null ? 'No median yet' : `$${Number(value).toFixed(3)}/L`;

export function FuelPriceMedianPanel({ organizationId }: { organizationId: string | null }) {
  const [fuelType, setFuelType] = useState<FuelType>('petrol');
  const [median, setMedian] = useState<MedianFuelPrice | null>(null);
  const [observations, setObservations] = useState<FuelObservation[]>([]);
  const [sources, setSources] = useState<FuelPriceSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ observedOn: new Date().toISOString().slice(0, 10), price: '', sourceName: '', sourceUrl: '' });
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [sourceForm, setSourceForm] = useState({ name: '', sourceUrl: '', guidance: '' });
  const freshness = fuelMedianStatus(median?.observation_count ?? 0, median?.latest_observed_on);

  const load = useCallback(async () => {
    if (!organizationId) { setMedian(null); setObservations([]); setSources([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    // Website observations retain their source; the SQL function computes the trailing three-month median.
    const [medianRes, observationsRes, sourcesRes] = await Promise.all([
      supabase.rpc('get_median_fuel_price', { p_organization_id: organizationId, p_fuel_type: fuelType, p_as_at: null, p_months: 3 }),
      supabase.from('fuel_price_observations').select('id,fuel_type,observed_on,price_per_litre,source_name,source_url,source_published_at').eq('organization_id', organizationId).eq('fuel_type', fuelType).order('observed_on', { ascending: false }).limit(12),
      supabase.from('fuel_price_sources').select('id,name,source_url,fuel_type,refresh_guidance').eq('organization_id', organizationId).eq('fuel_type', fuelType).eq('active', true).order('name'),
    ]);
    if (medianRes.error || observationsRes.error || sourcesRes.error) {
      setError(medianRes.error?.message ?? observationsRes.error?.message ?? sourcesRes.error?.message ?? 'Fuel prices could not be loaded.');
      setLoading(false);
      return;
    }
    const row = Array.isArray(medianRes.data) ? medianRes.data[0] : medianRes.data;
    setMedian((row as MedianFuelPrice | null) ?? null);
    setObservations((observationsRes.data as FuelObservation[]) ?? []);
    setSources((sourcesRes.data as FuelPriceSource[]) ?? []);
    setSourceId((current) => current && (sourcesRes.data as FuelPriceSource[]).some((source) => source.id === current) ? current : '');
    setLoading(false);
  }, [fuelType, organizationId]);

  useEffect(() => { void load(); }, [load]);

  const record = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const selectedSource = sources.find((source) => source.id === sourceId) ?? null;
    const { error: rpcError } = await supabase.rpc(selectedSource ? 'record_approved_fuel_price_observation' : 'record_fuel_price_observation', selectedSource ? {
      p_client_request_id: requestId(), p_organization_id: organizationId, p_source_id: selectedSource.id, p_observed_on: form.observedOn,
      p_price_per_litre: Number(form.price), p_source_url: form.sourceUrl, p_source_published_at: null, p_source_reference: null, p_source_hash: null,
    } : {
      p_client_request_id: requestId(),
      p_organization_id: organizationId,
      p_fuel_type: fuelType,
      p_observed_on: form.observedOn,
      p_price_per_litre: Number(form.price),
      p_source_name: form.sourceName,
      p_source_url: form.sourceUrl,
      p_source_published_at: null,
      p_source_reference: null,
      p_source_hash: null,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setNotice('Website price recorded. The three-month median has been recalculated.');
      setForm({ observedOn: new Date().toISOString().slice(0, 10), price: '', sourceName: '', sourceUrl: '' });
      setShowForm(false);
      await load();
    }
    setSaving(false);
  };

  const approveSource = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: rpcError } = await supabase.rpc('manage_fuel_price_source', {
      p_client_request_id: requestId(), p_organization_id: organizationId, p_action: 'approve', p_source_id: null,
      p_name: sourceForm.name, p_source_url: sourceForm.sourceUrl, p_fuel_type: fuelType, p_refresh_guidance: sourceForm.guidance || null,
    });
    if (rpcError) setError(rpcError.message);
    else { setNotice('Fuel price source approved. New observations from it are checked against its URL.'); setShowSourceForm(false); setSourceForm({ name: '', sourceUrl: '', guidance: '' }); setSourceId((data as FuelPriceSource).id); await load(); }
    setSaving(false);
  };

  const retireSource = async (source: FuelPriceSource) => {
    if (!organizationId) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: rpcError } = await supabase.rpc('manage_fuel_price_source', {
      p_client_request_id: requestId(), p_organization_id: organizationId, p_action: 'retire', p_source_id: source.id,
      p_name: null, p_source_url: null, p_fuel_type: source.fuel_type, p_refresh_guidance: null,
    });
    if (rpcError) setError(rpcError.message);
    else { setNotice(`${source.name} retired. It stays in prior citations but cannot receive new observations.`); await load(); }
    setSaving(false);
  };

  return (
    <section className="fuel-price-panel" aria-labelledby="fuel-price-title">
      <header className="fuel-price-panel__header">
        <div>
          <p className="fuel-price-panel__eyebrow">Travel planning input</p>
          <h2 id="fuel-price-title">Fuel price: three-month median</h2>
          <p>The median is based on cited website prices from the last three months. It helps you review travel costs; it does not automatically change the IRD $1.04/km customer charge.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading || saving} aria-label="Refresh fuel prices">
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </header>

      <div className="fuel-price-panel__controls">
        <label htmlFor="fuel-type"><span>Fuel type</span><select id="fuel-type" value={fuelType} onChange={(event) => setFuelType(event.target.value as FuelType)} disabled={loading || saving}>
          {(Object.keys(FUEL_LABELS) as FuelType[]).map((type) => <option key={type} value={type}>{FUEL_LABELS[type]}</option>)}
        </select></label>
        <div className="fuel-price-panel__median"><span>Median price</span><strong>{loading ? 'Checking…' : moneyPerLitre(median?.median_price_per_litre)}</strong><small>{median ? `${median.observation_count} observations, ${median.window_start} to ${median.window_end}` : 'Add cited website prices to calculate it.'}</small></div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm((value) => !value)} disabled={!organizationId || saving}>{showForm ? 'Cancel' : 'Record website price'}</button>
      </div>

      <div className="fuel-price-panel__sources-control"><span>{sources.length} approved source{sources.length === 1 ? '' : 's'} for {FUEL_LABELS[fuelType].toLowerCase()}.</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSourceForm((value) => !value)} disabled={!organizationId || saving}>{showSourceForm ? 'Cancel source' : 'Approve a source'}</button></div>

      {!loading && sources.length > 0 && <ul className="fuel-price-panel__approved-sources">{sources.map((source) => <li key={source.id}><div><strong>{source.name}</strong><a href={source.source_url} target="_blank" rel="noreferrer">{source.source_url} <ExternalLink size={12} aria-hidden="true" /></a>{source.refresh_guidance && <small>{source.refresh_guidance}</small>}</div><button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => void retireSource(source)}>Retire source</button></li>)}</ul>}

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <p className="fuel-price-panel__notice" role="status">{notice}</p>}
      {!loading && <p className={`fuel-price-panel__freshness fuel-price-panel__freshness--${freshness.state}`} role="status">{freshness.message}</p>}

      {showSourceForm && <form className="assessment-form fuel-price-panel__form" onSubmit={approveSource}><div className="form-row"><label><span>Website / publisher</span><input required value={sourceForm.name} onChange={(event) => setSourceForm({ ...sourceForm, name: event.target.value })} placeholder="e.g. Fuel Watch" /></label><label><span>Approved base URL</span><input type="url" required value={sourceForm.sourceUrl} onChange={(event) => setSourceForm({ ...sourceForm, sourceUrl: event.target.value })} placeholder="https://…" /></label></div><label><span>Review guidance (optional)</span><input value={sourceForm.guidance} onChange={(event) => setSourceForm({ ...sourceForm, guidance: event.target.value })} placeholder="e.g. Check weekly, use Nelson price" /></label><button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Approving…' : 'Approve source'}</button></form>}

      {showForm && <form className="assessment-form fuel-price-panel__form" onSubmit={record}>
        {sources.length > 0 && <label><span>Approved source (recommended)</span><select value={sourceId} onChange={(event) => { const source = sources.find((row) => row.id === event.target.value) ?? null; setSourceId(event.target.value); if (source) setForm((current) => ({ ...current, sourceName: source.name, sourceUrl: source.source_url })); }}><option value="">Record a historical/manual citation</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
        <div className="form-row">
          <label><span>Date shown by the website</span><input type="date" required value={form.observedOn} onChange={(event) => setForm({ ...form, observedOn: event.target.value })} /></label>
          <label><span>Price per litre (NZD)</span><input type="number" min="0.001" step="0.001" required value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="e.g. 2.399" /></label>
        </div>
        <div className="form-row">
          <label><span>Website / publisher</span><input required value={form.sourceName} onChange={(event) => setForm({ ...form, sourceName: event.target.value })} placeholder="e.g. AA Fuel Prices" /></label>
          <label><span>Source URL</span><input type="url" required value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} placeholder="https://…" /></label>
        </div>
        <p className="fuel-price-panel__hint">Use a public source that shows the date and price. This records the citation with the price so someone can check it later.</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Recording…' : 'Save cited price'}</button>
      </form>}

      {!loading && observations.length > 0 && <ul className="fuel-price-panel__sources">
        {observations.map((observation) => <li key={observation.id}><span>{observation.observed_on}</span><strong>{moneyPerLitre(observation.price_per_litre)}</strong><a href={observation.source_url} target="_blank" rel="noreferrer">{observation.source_name} <ExternalLink size={12} aria-hidden="true" /></a></li>)}
      </ul>}
    </section>
  );
}
