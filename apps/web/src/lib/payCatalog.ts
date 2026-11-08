import { supabase } from './supabase';

// Mirrors the rate_rules_rate_type_check constraint; PostgREST cannot expose CHECK values.
export const RATE_TYPES = ['hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage', 'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice'] as const;

export const validPayrollCode = (value: string) => /^[A-Z0-9][A-Z0-9_-]*$/.test(value);

export interface PayCode { id: string; code: string; name: string }

export const loadPayCodes = async (organizationId: string): Promise<PayCode[]> => {
  const { data, error } = await supabase.from('reference_codes').select('id,code,name')
    .eq('organization_id', organizationId).eq('code_type', 'pay_item').eq('is_active', true)
    .order('sort_order').order('code');
  if (error) throw error;
  return (data ?? []) as PayCode[];
};

export const loadServiceCatalog = async (organizationId?: string | null): Promise<string[]> => {
  const [catalog, rostered] = await Promise.all([
    supabase.from('module_catalog').select('module_key').eq('active', true),
    organizationId
      ? supabase.from('roster_work_units').select('service_type').eq('organization_id', organizationId).eq('active', true)
      : Promise.resolve({ data: [] as { service_type: string }[], error: null }),
  ]);
  if (catalog.error) throw catalog.error;
  if (rostered.error) throw rostered.error;
  const keys = new Set<string>();
  (catalog.data ?? []).forEach((row) => keys.add(String(row.module_key)));
  (rostered.data ?? []).forEach((row) => { if (row.service_type) keys.add(String(row.service_type)); });
  return [...keys].sort((a, b) => a.localeCompare(b));
};

export const serviceLabel = (key: string | null | undefined) => key ? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'All tasks';

export const createPayCode = async (code: string, name: string): Promise<PayCode> => {
  const normalised = code.trim().toUpperCase();
  if (!validPayrollCode(normalised) || !name.trim()) throw new Error('Use letters, numbers, underscores or hyphens for the code, and give it a name.');
  const { data, error } = await supabase.rpc('manage_pay_code', { p_action: 'create', p_pay_code_id: null, p_code: normalised, p_name: name.trim() });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as PayCode | null;
  if (!row?.code) throw new Error('The pay code was not returned. Reload and check the pay code list.');
  return { id: row.id, code: row.code, name: row.name };
};
