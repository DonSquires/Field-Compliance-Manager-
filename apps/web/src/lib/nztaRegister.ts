/**
 * NZTA s241 Motor Vehicle Register (MVR) vocabulary shared by the reveal dialog,
 * the lookup register and the annual summary. Purposes mirror R&M's Gazette
 * notice 2025-au4644; permit vetting and general investigations are not
 * authorised purposes and must never be offered here.
 */
export type LookupPurpose = 'trespass_unpermitted_vehicle' | 'cctv_patrol_signage_breach';
export type RevealPurpose = LookupPurpose | 'notice_follow_up';
export type LookupOutcome = 'pending' | 'trespass_notice' | 'damage_letter' | 'debt_collection' | 'no_action';

export const LOOKUP_PURPOSES: Array<{ id: LookupPurpose; label: string; hint: string }> = [
  {
    id: 'trespass_unpermitted_vehicle',
    label: 'Vehicle on a contracted property without a valid permit',
    hint: 'Trespass by a vehicle on a property R&M is contracted to protect.',
  },
  {
    id: 'cctv_patrol_signage_breach',
    label: 'Entry or damage seen on CCTV or patrol against posted signage',
    hint: 'Unauthorised entry or damage recorded where conditions of entry are signposted.',
  },
];

export const REVEAL_PURPOSES: Array<{ id: RevealPurpose; label: string; hint: string }> = [
  ...LOOKUP_PURPOSES,
  {
    id: 'notice_follow_up',
    label: 'Following up a trespass or warning notice already issued',
    hint: 'Serving, enforcing or answering a query about a notice issued for one of the purposes above.',
  },
];

export const LOOKUP_OUTCOMES: Array<{ id: LookupOutcome; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'trespass_notice', label: 'Trespass notice issued' },
  { id: 'damage_letter', label: 'Damage or payment letter sent' },
  { id: 'debt_collection', label: 'Referred to debt collection' },
  { id: 'no_action', label: 'No further action' },
];

const LABELS: Record<string, string> = Object.fromEntries([
  ...REVEAL_PURPOSES.map((purpose) => [purpose.id, purpose.label]),
  ...LOOKUP_OUTCOMES.map((outcome) => [outcome.id, outcome.label]),
]);

export const nztaLabel = (value: string | null | undefined, fallback = 'Not recorded') =>
  value ? LABELS[value] ?? value.replace(/_/g, ' ') : fallback;

export const NZTA_PERSON_LABEL = 'Registered person (at check date)';

export const NZTA_PERSON_NOTE =
  'The person NZTA held on the register on the check date. This is not proof of ownership, and it is not a transfer date.';

export const NZTA_USE_NOTICE =
  'NZTA register information may only be used for the purpose it was obtained for. Do not share it with clients or other organisations, except the organisation a notice was issued on behalf of.';

export const MIN_EXPLANATION = 10;

/** RFC 4180 CSV with formula-injection guarding for spreadsheet tools. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: Array<[string, string]>): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(([, header]) => cell(header)).join(','),
    ...rows.map((row) => columns.map(([key]) => cell(row[key])).join(','))].join('\r\n');
}

export function downloadCsv(fileName: string, csv: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const formatNzDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
