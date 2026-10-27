export type PermitValidityState =
  | 'valid'
  | 'expiring_soon'
  | 'expired'
  | 'not_started'
  | 'dates_not_recorded'
  | 'revoked'
  | 'suspended';

export interface PermitVehicle {
  canonical_vehicle_id: string | null;
  plate_number: string;
  make?: string | null;
  model?: string | null;
  colour?: string | null;
}

/** One forest/site access permit as read from search_people or person_permits_fieldwork. */
export interface PermitSummary {
  id: string;
  permit_number: string;
  permit_type: string | null;
  status: string;
  validity_state?: PermitValidityState | null;
  date_from: string | null;
  date_to: string | null;
  holder_name?: string | null;
  canonical_person_id?: string | null;
  organization_name?: string | null;
  client_organization_name?: string | null;
  applicant_type?: string | null;
  company_name?: string | null;
  forest_areas?: string[] | null;
  activities?: string[] | null;
  hunting_season?: string | null;
  firearm_licence_valid?: boolean | null;
  chainsaw_safety_equipment?: boolean | null;
  keys_issued?: boolean | null;
  conditions?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  address_text?: string | null;
  compliance_checked_at?: string | null;
  source_document?: string | null;
  vehicles?: PermitVehicle[];
}

const VALIDITY_LABELS: Record<PermitValidityState, string> = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  not_started: 'Not yet started',
  dates_not_recorded: 'Dates not recorded',
  revoked: 'Revoked',
  suspended: 'Suspended',
};

export const permitValidityLabel = (state: PermitValidityState): string => VALIDITY_LABELS[state] ?? state;

export const permitIsCurrent = (state: PermitValidityState): boolean => state === 'valid' || state === 'expiring_soon';

export const permitValidityTone = (state: PermitValidityState): 'ok' | 'watch' | 'critical' | 'neutral' => {
  if (state === 'valid') return 'ok';
  if (state === 'expiring_soon' || state === 'not_started') return 'watch';
  if (state === 'expired' || state === 'revoked' || state === 'suspended') return 'critical';
  return 'neutral';
};

const nzToday = (now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * The server derives validity (public.person_permit_validity); this mirror is used
 * only when a row was read without it, so the badge never falls back to raw status.
 */
export const permitValidity = (permit: Pick<PermitSummary, 'status' | 'validity_state' | 'date_from' | 'date_to'>, now = new Date()): PermitValidityState => {
  if (permit.validity_state) return permit.validity_state;
  if (permit.status === 'revoked' || permit.status === 'suspended' || permit.status === 'expired') return permit.status;
  const today = nzToday(now);
  const from = permit.date_from?.slice(0, 10) ?? null;
  const to = permit.date_to?.slice(0, 10) ?? null;
  if (to && to < today) return 'expired';
  if (from && from > today) return 'not_started';
  if (!from && !to) return 'dates_not_recorded';
  if (to && to <= addDays(today, 30)) return 'expiring_soon';
  return 'valid';
};

export const permitAnswer = (value: boolean | null | undefined, yes = 'Yes', no = 'No'): string =>
  value === true ? yes : value === false ? no : 'Not recorded';
