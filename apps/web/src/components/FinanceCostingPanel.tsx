import { useEffect, useState } from 'react';
import { Calculator, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { fuelCostPerKm, suggestedVehicleVariableCost } from '../lib/fuelCosting';
import { supabase } from '../lib/supabase';
import './FinanceCostingPanel.css';

type CostInputs = {
  labour_hours: string;
  base_hourly_rate: string;
  labour_oncost_pct: string;
  leave_provision_pct: string;
  vehicle_km: string;
  vehicle_fuel_consumption_l_per_100km: string;
  vehicle_running_cost_per_km: string;
  vehicle_fixed_annual: string;
  vehicle_productive_hours: string;
  vehicle_variable_per_km: string;
  asset_acquisition_cost: string;
  asset_setup_cost: string;
  asset_residual_value: string;
  asset_useful_life_months: string;
  equipment_cost: string;
  direct_operating_cost: string;
  overhead_pct: string;
  target_margin_pct: string;
  client_charge: string;
};

const initialInputs: CostInputs = {
  labour_hours: '8', base_hourly_rate: '', labour_oncost_pct: '15', leave_provision_pct: '8',
  vehicle_km: '0', vehicle_fuel_consumption_l_per_100km: '', vehicle_running_cost_per_km: '0', vehicle_fixed_annual: '0', vehicle_productive_hours: '0', vehicle_variable_per_km: '0',
  asset_acquisition_cost: '', asset_setup_cost: '0', asset_residual_value: '0', asset_useful_life_months: '60',
  equipment_cost: '0', direct_operating_cost: '0', overhead_pct: '10', target_margin_pct: '25', client_charge: '',
};

type CostResult = { true_cost: number; client_charge: number; gross_margin: number; gross_margin_pct: number; breakdown: Record<string, number>; };

const fields: Array<[keyof CostInputs, string]> = [
  ['labour_hours', 'Hours worked'], ['base_hourly_rate', 'Hourly pay rate'], ['labour_oncost_pct', 'Extra wage costs %'], ['leave_provision_pct', 'Holiday/leave allowance %'],
  ['vehicle_km', 'Vehicle kilometres'], ['vehicle_fuel_consumption_l_per_100km', 'Fuel use (L/100km)'], ['vehicle_running_cost_per_km', 'Other running cost/km'], ['vehicle_fixed_annual', 'Yearly vehicle cost'], ['vehicle_productive_hours', 'Billable vehicle hours/year'], ['vehicle_variable_per_km', 'Fuel and running cost/km'],
  ['asset_acquisition_cost', 'Gear purchase cost'], ['asset_setup_cost', 'Setup cost'], ['asset_residual_value', 'Expected resale value'], ['asset_useful_life_months', 'How many months it will be used'],
  ['equipment_cost', 'Equipment/evidence cost'], ['direct_operating_cost', 'Other job cost'], ['overhead_pct', 'Shared business costs %'], ['target_margin_pct', 'Money left target %'], ['client_charge', 'Price to customer override'],
];

const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);

export function FinanceCostingPanel() {
  const { profile, operatingOrganizationId } = useAuth();
  const [inputs, setInputs] = useState<CostInputs>(initialInputs);
  const [medianFuelPrice, setMedianFuelPrice] = useState<number | null>(null);
  const [fuelObservationCount, setFuelObservationCount] = useState(0);
  const [result, setResult] = useState<CostResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  useEffect(() => {
    if (!organizationId) { setMedianFuelPrice(null); setFuelObservationCount(0); return; }
    void supabase.rpc('get_median_fuel_price', { p_organization_id: organizationId, p_fuel_type: 'petrol', p_as_at: null, p_months: 3 }).then(({ data, error: medianError }) => {
      if (medianError) return;
      const row = Array.isArray(data) ? data[0] : data;
      setMedianFuelPrice(row?.median_price_per_litre == null ? null : Number(row.median_price_per_litre));
      setFuelObservationCount(Number(row?.observation_count ?? 0));
    });
  }, [organizationId]);

  const fuelOnlyPerKm = fuelCostPerKm(medianFuelPrice, Number(inputs.vehicle_fuel_consumption_l_per_100km));
  const suggestedPerKm = suggestedVehicleVariableCost(fuelOnlyPerKm, Number(inputs.vehicle_running_cost_per_km));
  const applyFuelSuggestion = () => {
    if (suggestedPerKm === null) return;
    setInputs((current) => ({ ...current, vehicle_variable_per_km: suggestedPerKm.toFixed(4) }));
  };

  const calculate = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    const payload = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)]));
    const { data, error: calculationError } = await supabase.rpc('calculate_finance_quote_cost', { p_inputs: payload });
    if (calculationError) setError(calculationError.message);
    else setResult(data as CostResult);
    setSaving(false);
  };

  return <section className="reports-section" aria-label="Job cost calculator">
    <div className="crm-section-heading"><div><span>Before you quote</span><h2><Calculator size={18} /> Check the real job cost</h2><p className="subtitle">Enter the source facts. The server adds wages, leave, vehicle use, gear, travel, shared business costs, and the amount you want left over.</p></div><button type="button" className="btn btn-secondary" onClick={() => { setInputs(initialInputs); setResult(null); setError(null); }}><RefreshCw size={15} /> Reset</button></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <form className="assessment-form" onSubmit={calculate}><div className="form-row">{fields.map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" step={key.includes('per_km') ? '0.0001' : '0.01'} value={inputs[key]} onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>{medianFuelPrice !== null && <div className="finance-fuel-suggestion"><strong>Website fuel median: ${medianFuelPrice.toFixed(3)}/L</strong><span>{fuelObservationCount} cited observation{fuelObservationCount === 1 ? '' : 's'} in the last three months. {fuelOnlyPerKm === null ? 'Enter fuel use to calculate the fuel cost per kilometre.' : `Fuel is ${money(fuelOnlyPerKm)}/km; with other running cost, suggested internal vehicle cost is ${money(suggestedPerKm ?? 0)}/km.`}</span>{suggestedPerKm !== null && <button type="button" className="btn btn-secondary btn-sm" onClick={applyFuelSuggestion}>Use suggested internal cost</button>}<small>This affects this cost check only. It does not change the IRD $1.04/km customer charge.</small></div>}<button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Calculating...' : 'Calculate job cost'}</button></form>
    {result && <div className="crm-finance-kpis" role="status"><span>Real cost <strong>{money(result.true_cost)}</strong></span><span>Price to customer <strong>{money(result.client_charge)}</strong></span><span>Left after costs <strong>{money(result.gross_margin)} ({result.gross_margin_pct}%)</strong></span><span>Gear cost per year <strong>{money(result.breakdown.depreciation_annual ?? 0)}</strong></span></div>}
  </section>;
}
