/** Credentials in plain words: type labels and what an expiry date means today. */
export const CREDENTIAL_TYPES: Array<[string, string]> = [
  ['security_licence', 'Security licence (PSPLA)'],
  ['certificate_of_authority', 'Certificate of authority'],
  ['warrant_of_authority', 'Warrant of authority'],
  ['noise_control_warrant', 'Noise control warrant'],
  ['biosecurity_warrant', 'Biosecurity warrant'],
  ['first_aid', 'First aid'],
  ['drivers_licence', 'Driver licence'],
  ['firearms_licence', 'Firearms licence'],
  ['other', 'Other'],
];

/** 'security_licence' -> 'Security licence (PSPLA)'; unknown codes read as words rather than snake_case. */
export const credentialTypeLabel = (type: string | null | undefined): string => {
  if (!type) return 'Credential';
  const known = CREDENTIAL_TYPES.find(([code]) => code === type);
  if (known) return known[1];
  const words = type.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export type CredentialExpiryState = 'expired' | 'expiring' | 'current' | 'none';

export const credentialExpiryState = (expiryDate: string | null | undefined, now = new Date()): CredentialExpiryState => {
  if (!expiryDate) return 'none';
  const days = (new Date(expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (days < 0) return 'expired';
  return days <= 30 ? 'expiring' : 'current';
};

const dayWords = (value: string) => new Date(value).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });

/** 'Expired 12 Aug 2026' · 'Expires 1 Oct 2026 — in 11 days' · 'Expires 4 Mar 2027' · 'No expiry'. */
export const credentialExpiryWords = (expiryDate: string | null | undefined, now = new Date()): string => {
  const state = credentialExpiryState(expiryDate, now);
  if (state === 'none' || !expiryDate) return 'No expiry';
  if (state === 'expired') return `Expired ${dayWords(expiryDate)}`;
  if (state === 'expiring') {
    const days = Math.max(0, Math.ceil((new Date(expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    return `Expires ${dayWords(expiryDate)} — ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`;
  }
  return `Expires ${dayWords(expiryDate)}`;
};
