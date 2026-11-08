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

export interface ServiceCode { code: string; name: string; source: string }

// One catalogue for every task picker: registered task codes, modules, and tasks the organisation already rosters.
export const loadServiceCatalog = async (organizationId?: string | null): Promise<ServiceCode[]> => {
  if (!organizationId) return [];
  const { data, error } = await supabase.rpc('list_service_codes', { p_organization_id: organizationId });
  if (error) throw error;
  return ((data ?? []) as ServiceCode[]).filter((row) => row.code);
};

const humanise = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const serviceLabel = (key: string | null | undefined, catalog?: ServiceCode[]) =>
  key ? catalog?.find((row) => row.code === key)?.name ?? humanise(key) : 'All tasks';

export const createServiceCode = async (name: string, organizationId?: string | null): Promise<ServiceCode> => {
  if (!/[a-z]/i.test(name.trim())) throw new Error('Give the task a name that starts with a letter, for example "Camera review".');
  const { data, error } = await supabase.rpc('manage_service_code', {
    p_action: 'create', p_name: name.trim(), p_code: null, p_organization_id: organizationId ?? null,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { code?: string; name?: string } | null;
  if (!row?.code) throw new Error('The task was not returned. Reload and check the task list.');
  return { code: row.code, name: row.name ?? humanise(row.code), source: 'registered' };
};

export const createPayCode = async (code: string, name: string): Promise<PayCode> => {
  const normalised = code.trim().toUpperCase();
  if (!validPayrollCode(normalised) || !name.trim()) throw new Error('Use letters, numbers, underscores or hyphens for the code, and give it a name.');
  const { data, error } = await supabase.rpc('manage_pay_code', { p_action: 'create', p_pay_code_id: null, p_code: normalised, p_name: name.trim() });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as PayCode | null;
  if (!row?.code) throw new Error('The pay code was not returned. Reload and check the pay code list.');
  return { id: row.id, code: row.code, name: row.name };
};
