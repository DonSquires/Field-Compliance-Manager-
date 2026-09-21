/** Where a service agreement is in its life, from starts_on / ends_on (inclusive dates). Pure; shared by CRM, the portal and dispatch. */
export interface AgreementTermDates { starts_on: string | null; ends_on: string | null }
export type AgreementTermState = 'live' | 'ending' | 'ended' | 'cancelled';

export const dayWords = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
export const localToday = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** 'live' while ends_on is null or today or later; 'ended' after; 'cancelled' when it ended before it started. */
export const agreementTermState = (agreement: AgreementTermDates, today = localToday()): AgreementTermState => {
  if (!agreement.ends_on) return 'live';
  if (agreement.starts_on && agreement.ends_on < agreement.starts_on) return 'cancelled';
  if (agreement.ends_on < today) return 'ended';
  return agreement.ends_on === today ? 'ending' : 'live';
};

/** 'In force since 20 Sep 2026' · 'In force since 20 Sep 2026 · ends 30 Sep 2026' · 'Ended 19 Sep 2026' · 'Cancelled before it took effect'. */
export const agreementTermWords = (agreement: AgreementTermDates, today = localToday()): string => {
  const state = agreementTermState(agreement, today);
  if (state === 'cancelled') return 'Cancelled before it took effect';
  if (state === 'ended') return `Ended ${dayWords(agreement.ends_on as string)}`;
  const since = agreement.starts_on ? `In force since ${dayWords(agreement.starts_on)}` : 'In force';
  if (state === 'ending') return `${since} · ends today`;
  return agreement.ends_on ? `${since} · ends ${dayWords(agreement.ends_on)}` : since;
};

/** Live agreements first (newest first within a group), then upcoming, then ended and cancelled. */
export const agreementTermRank = (agreement: AgreementTermDates, today = localToday()): number => {
  const state = agreementTermState(agreement, today);
  if (state === 'live' || state === 'ending') return agreement.starts_on && agreement.starts_on > today ? 1 : 0;
  return state === 'ended' ? 2 : 3;
};

/** Short suffix for a selector option: '' while live, ' · ended 19 Sep 2026', ' · cancelled', ' · starts 1 Oct 2026'. */
export const agreementOptionSuffix = (agreement: AgreementTermDates, today = localToday()): string => {
  const state = agreementTermState(agreement, today);
  if (state === 'cancelled') return ' · cancelled';
  if (state === 'ended') return ` · ended ${dayWords(agreement.ends_on as string)}`;
  if (agreement.starts_on && agreement.starts_on > today) return ` · starts ${dayWords(agreement.starts_on)}`;
  return '';
};
