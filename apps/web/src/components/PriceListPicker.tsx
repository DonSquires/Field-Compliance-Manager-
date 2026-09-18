/**
 * PriceListPicker — "pick from your price list" for quotes and job costs.
 *
 * Reads the organisation's customer charge rules (rate_rules, rule_kind =
 * 'billing'), staff pay rules (for a matching cost), and the price book view
 * (finance_price_book: materials/equipment with current approved cost and
 * price). Selecting an entry hands back a ready-to-use line; nothing is
 * written here.
 */
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isIrdDefaultKilometreRate, itemToSelection, rateToSelection, RATE_UNITS, type PriceListItem, type PriceListRate, type PriceListSelection } from '../lib/priceList';
import './PriceListPicker.css';

export function usePriceList(organizationIds: string[]) {
  const [rates, setRates] = useState<PriceListRate[]>([]);
  const [items, setItems] = useState<PriceListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = organizationIds.filter(Boolean).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    if (!key) { setRates([]); setItems([]); return; }
    const ids = key.split(',');
    // ATLAS READS: rate_rules, finance_price_book (view over finance_item_catalog + cost/price versions)
    void Promise.all([
      supabase.from('rate_rules').select('id,organization_id,name,rate_type,amount,service_type,rule_kind').in('organization_id', ids).eq('active', true).order('name'),
      supabase.from('finance_price_book').select('item_id,organization_id,sku,name,item_type,unit_of_measure,unit_cost,unit_price').in('organization_id', ids).eq('active', true).order('name'),
    ]).then(([rateRes, itemRes]) => {
      if (cancelled) return;
      if (rateRes.error || itemRes.error) { setError(rateRes.error?.message ?? itemRes.error?.message ?? 'Price list could not be loaded'); return; }
      setError(null);
      setRates((rateRes.data as PriceListRate[]) ?? []);
      setItems((itemRes.data as PriceListItem[]) ?? []);
    });
    return () => { cancelled = true; };
  }, [key]);
  const billing = useMemo(() => rates.filter((rate) => rate.rule_kind === 'billing'), [rates]);
  const pay = useMemo(() => rates.filter((rate) => rate.rule_kind === 'pay'), [rates]);
  return { billingRates: billing, payRates: pay, items, error };
}

const money = (value: number | null) => value === null ? '—' : `$${value.toFixed(2)}`;

export type { PriceListItem, PriceListRate, PriceListSelection } from '../lib/priceList';

export function PriceListPicker({ organizationIds, value, onSelect, label = 'Pick from your price list', id = 'price-list-picker', includeRates = true, includeItems = true }: {
  organizationIds: string[];
  value: string;
  onSelect: (selection: PriceListSelection | null, token: string) => void;
  label?: string;
  id?: string;
  includeRates?: boolean;
  includeItems?: boolean;
}) {
  const { billingRates, payRates, items, error } = usePriceList(organizationIds);
  const empty = (!includeRates || billingRates.length === 0) && (!includeItems || items.length === 0);
  const selectedRate = value.startsWith('rate:') ? billingRates.find((rate) => rate.id === value.slice(5)) : null;
  return (
    <label className="price-list-picker">
      <span>{label}</span>
      <select id={id} value={value} disabled={empty} aria-describedby={`${id}-hint`} onChange={(event) => {
        const token = event.target.value;
        if (!token) { onSelect(null, ''); return; }
        const [source, selectedId] = token.split(':');
        if (source === 'rate') { const rate = billingRates.find((candidate) => candidate.id === selectedId); onSelect(rate ? rateToSelection(rate, payRates) : null, token); }
        else { const item = items.find((candidate) => candidate.item_id === selectedId); onSelect(item ? itemToSelection(item) : null, token); }
      }}>
        <option value="">{empty ? 'No price list yet — add rates or materials first' : 'Type it in myself'}</option>
        {includeRates && billingRates.length > 0 && <optgroup label="Rates">{billingRates.map((rate) => <option key={rate.id} value={`rate:${rate.id}`}>{rate.name} — {money(Number(rate.amount))} per {RATE_UNITS[rate.rate_type] ?? rate.rate_type.replaceAll('_', ' ')}</option>)}</optgroup>}
        {includeItems && items.length > 0 && <optgroup label="Materials and equipment">{items.map((item) => <option key={item.item_id} value={`item:${item.item_id}`}>{item.sku} · {item.name} — {money(item.unit_price === null ? null : Number(item.unit_price))} per {item.unit_of_measure}</option>)}</optgroup>}
      </select>
      <small id={`${id}-hint`}>{error ?? (isIrdDefaultKilometreRate(selectedRate) ? 'IRD customer charge selected. Website fuel median informs internal job costing only; it does not change this customer price.' : 'Fills the line for you. You can still change any number before saving.')}</small>
    </label>
  );
}
