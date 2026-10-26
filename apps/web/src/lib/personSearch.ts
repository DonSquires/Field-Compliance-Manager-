export type NoticeExpiryState = 'draft' | 'withdrawn' | 'no_expiry' | 'in_force' | 'expiring_soon' | 'expired';

export interface PersonNotice {
  notice_id: string;
  organization_id: string;
  organization_name: string;
  notice_type: string;
  notice_number: string | null;
  status: string;
  issued_at: string | null;
  expires_at: string | null;
  expiry_state: NoticeExpiryState;
  location_name: string | null;
}

export interface PersonVehicle {
  canonical_vehicle_id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  relationship: string | null;
  since: string | null;
}

export interface PersonNzta {
  address: string | null;
  last_checked_at: string | null;
  checks: Array<{ plate_number: string; checked_at: string }>;
}

export interface PersonMatch {
  canonical_person_id: string;
  display_name: string;
  review_state: string | null;
  homeless_status: string | null;
  has_notice_in_force: boolean;
  aliases: string[];
  organizations: string[];
  notices: PersonNotice[];
  vehicles: PersonVehicle[];
  nzta_authorised: boolean;
  nzta: PersonNzta | null;
}

export interface NoticeRegisterRow {
  notice_id: string;
  organization_id: string;
  organization_name: string;
  notice_type: string;
  notice_number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  expiry_state: NoticeExpiryState;
  days_remaining: number | null;
  canonical_person_id: string | null;
  person_display_name: string | null;
  location_name: string | null;
}

const EXPIRY_LABELS: Record<NoticeExpiryState, string> = {
  draft: 'Draft, not served',
  withdrawn: 'Withdrawn',
  no_expiry: 'No expiry recorded',
  in_force: 'In force',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
};

export const noticeExpiryLabel = (state: NoticeExpiryState): string => EXPIRY_LABELS[state] ?? state;

/** In force and expiring notices still bar entry; an expired one needs a renewal decision. */
export const noticeStillBarsEntry = (state: NoticeExpiryState): boolean => state === 'in_force' || state === 'expiring_soon';

const NOTICE_TYPE_LABELS: Record<string, string> = {
  trespass: 'Trespass notice',
  warning: 'Warning notice',
  permit_refusal: 'Permit refusal letter',
  contact_request: 'Contact request letter',
};

export const noticeTypeLabel = (type: string): string =>
  NOTICE_TYPE_LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1).replace(/_/g, ' ')} notice`;

export const formatNzDate = (value: string | null): string => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleDateString('en-NZ', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland' });
};

export const describeDaysRemaining = (days: number | null): string => {
  if (days === null) return '';
  if (days === 0) return 'expires today';
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} left`;
  const ago = Math.abs(days);
  return `expired ${ago} day${ago === 1 ? '' : 's'} ago`;
};

export const personSearchQueryIsValid = (query: string): boolean => query.replace(/[^a-z0-9]/gi, '').length >= 2;
