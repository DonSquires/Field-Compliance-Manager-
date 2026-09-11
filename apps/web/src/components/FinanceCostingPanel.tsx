import { useState } from 'react';
import { Calculator, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';

type CostInputs = {
  labour_hours: string;
  base_hourly_rate: string;
  labour_oncost_pct: string;
  leave_provision_pct: string;
  vehicle_km: string;
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
  vehicle_km: '0', vehicle_fixed_annual: '0', vehicle_productive_hours: '0', vehicle_variable_per_km: '0',
  asset_acquisition_cost: '', asset_setup_cost: '0', asset_residual_value: '0', asset_useful_life_months: '60',
  equipment_cost: '0', direct_operating_cost: '0', overhead_pct: '10', target_margin_pct: '25', client_charge: '',
};

type CostResult = { true_cost: number; client_charge: number; gross_margin: number; gross_margin_pct: number; breakdown: Record<string, number>; };

const fields: Array<[keyof CostInputs, string]> = [
  ['labour_hours', 'Labour hours'], ['base_hourly_rate', 'Base hourly rate'], ['labour_oncost_pct', 'Labour on-cost %'], ['leave_provision_pct', 'Leave provision %'],
  ['vehicle_km', 'Vehicle kilometres'], ['vehicle_fixed_annual', 'Vehicle fixed annual cost'], ['vehicle_productive_hours', 'Vehicle productive hours/year'], ['vehicle_variable_per_km', 'Vehicle running cost/km'],
  ['asset_acquisition_cost', 'Asset acquisition cost'], ['asset_setup_cost', 'Asset setup cost'], ['asset_residual_value', 'Asset residual value'], ['asset_useful_life_months', 'Asset useful life (months)'],
  ['equipment_cost', 'Equipment/evidence cost'], ['direct_operating_cost', 'Other direct cost'], ['overhead_pct', 'Overhead allocation %'], ['target_margin_pct', 'Target margin %'], ['client_charge', 'Client charge override'],
];

const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);

export function FinanceCostingPanel() {
  const [inputs, setInputs] = useState<CostInputs>(initialInputs);
  const [result, setResult] = useState<CostResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const calculate = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    const payload = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)]));
    const { data, error: calculationError } = await supabase.rpc('calculate_finance_quote_cost', { p_inputs: payload });
    if (calculationError) setError(calculationError.message);
    else setResult(data as CostResult);
    setSaving(false);
  };

  return <section className="reports-section" aria-label="Service costing calculator">
    <div className="crm-section-heading"><div><span>Finance foundation</span><h2><Calculator size={18} /> Cost service before quoting</h2><p className="subtitle">Enter original source facts. Server calculation includes loaded labour, vehicle depreciation, travel, direct cost, overhead, and margin.</p></div><button type="button" className="btn btn-secondary" onClick={() => { setInputs(initialInputs); setResult(null); setError(null); }}><RefreshCw size={15} /> Reset</button></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <form className="assessment-form" onSubmit={calculate}><div className="form-row">{fields.map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" step="0.01" value={inputs[key]} onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Calculating...' : 'Calculate true service cost'}</button></form>
    {result && <div className="crm-finance-kpis" role="status"><span>True cost <strong>{money(result.true_cost)}</strong></span><span>Client charge <strong>{money(result.client_charge)}</strong></span><span>Gross margin <strong>{money(result.gross_margin)} ({result.gross_margin_pct}%)</strong></span><span>Annual depreciation <strong>{money(result.breakdown.depreciation_annual ?? 0)}</strong></span></div>}
  </section>;
}
