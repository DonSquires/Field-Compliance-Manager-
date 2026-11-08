import { useSyncExternalStore } from 'react';

export interface WorkforceScope { from: string; to: string; staffId: string | null; userId: string | null }
const EVENT = 'fcm-workforce-scope';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workforceWeek(now = new Date()): WorkforceScope {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const date = new Date(`${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const from = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { from, to: date.toISOString().slice(0, 10), staffId: null, userId: null };
}

function readScope(value: string | null): WorkforceScope {
  const fallback = workforceWeek();
  try {
    const parsed = JSON.parse(value ?? 'null') as WorkforceScope | null;
    if (!parsed || !DATE.test(parsed.from) || !DATE.test(parsed.to)
      || !Number.isFinite(Date.parse(parsed.from)) || !Number.isFinite(Date.parse(parsed.to))) return fallback;
    return { from: parsed.from, to: parsed.to, staffId: parsed.staffId && UUID.test(parsed.staffId) ? parsed.staffId : null,
      userId: parsed.userId && UUID.test(parsed.userId) ? parsed.userId : null };
  } catch { return fallback; }
}

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener('storage', notify);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', notify); };
};

export function useWorkforceScope(actorId: string | null | undefined, branchId: string | null | undefined) {
  const key = `fcm:workforce-scope:${actorId ?? 'none'}:${branchId ?? 'none'}`;
  const snapshot = useSyncExternalStore(subscribe, () => {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }, () => null);
  const scope = readScope(snapshot);
  const setScope = (next: WorkforceScope) => {
    if (!actorId || !branchId) return;
    try { sessionStorage.setItem(key, JSON.stringify(readScope(JSON.stringify(next)))); } catch { return; }
    window.dispatchEvent(new Event(EVENT));
  };
  return { scope, setScope };
}