/**
 * Pure price-list mapping: a customer charge rule or a price-book item becomes a
 * ready-to-use quote/job line. No I/O, so it is unit-testable without Supabase.
 */
export interface PriceListRate { id: string; organization_id: string; name: string; rate_type: string; amount: number; service_type: string | null; rule_kind: 'pay' | 'billing'; }
export interface PriceListItem { item_id: string; organization_id: string; sku: string; name: string; item_type: string; unit_of_measure: string; unit_cost: number | null; unit_price: number | null; }
export interface PriceListSelection {
  source: 'rate' | 'item';
  id: string;
  description: string;
  kind: 'labour' | 'travel' | 'materials' | 'equipment' | 'custom';
  costType: 'labour' | 'vehicle' | 'materials' | 'equipment' | 'other';
  unit: string;
  unitCharge: number | null;
  unitCost: number | null;
}

export const RATE_UNITS: Record<string, string> = { hourly: 'hour', daily: 'day', per_km: 'km', per_unit: 'unit', per_visit: 'visit', per_notice: 'notice', callout: 'callout', flat: 'job', per_hour_travel: 'hour', per_hour_allowance: 'hour', oncall_flat: 'period', higher_duties_flat: 'shift', percentage: '%' };

export function isIrdDefaultKilometreRate(rate: Pick<PriceListRate, 'rate_type' | 'name'> | null | undefined): boolean {
  return rate?.rate_type === 'per_km' && /ird recommended vehicle kilometre rate/i.test(rate.name);
}

export function rateToSelection(rate: PriceListRate, payRules: PriceListRate[]): PriceListSelection {
  const pay = rate.service_type ? payRules.find((rule) => rule.service_type === rate.service_type && rule.rate_type === rate.rate_type) : undefined;
  const kind = rate.rate_type === 'per_km' ? 'travel' : rate.rate_type === 'per_unit' ? 'equipment' : 'labour';
  return { source: 'rate', id: rate.id, description: rate.name, kind, costType: kind === 'travel' ? 'vehicle' : kind === 'equipment' ? 'equipment' : 'labour', unit: RATE_UNITS[rate.rate_type] ?? rate.rate_type.replaceAll('_', ' '), unitCharge: Number(rate.amount), unitCost: pay ? Number(pay.amount) : null };
}

export function itemToSelection(item: PriceListItem): PriceListSelection {
  const equipment = item.item_type === 'equipment_component';
  return { source: 'item', id: item.item_id, description: `${item.sku} · ${item.name}`, kind: equipment ? 'equipment' : 'materials', costType: equipment ? 'equipment' : 'materials', unit: item.unit_of_measure, unitCharge: item.unit_price === null ? null : Number(item.unit_price), unitCost: item.unit_cost === null ? null : Number(item.unit_cost) };
}

