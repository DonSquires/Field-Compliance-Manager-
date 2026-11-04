/**
 * New-job alerting for the officer portal: remembers which dispatch jobs the
 * officer has already been alerted to, and raises a chime, vibration and (when
 * permitted) a system notification for jobs that are new to this device.
 *
 * Browsers only allow audio and notification permission after a user gesture,
 * so `enableJobAlerts` must be called from a click handler.
 */

export const SEEN_JOBS_STORAGE_KEY = 'fcm.officer.seenDispatchJobs.v1';
const ALERTS_ENABLED_KEY = 'fcm.officer.jobAlertsEnabled.v1';
const MAX_SEEN = 200;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch { return null; }
}

export function readSeenJobIds(store: StorageLike | null = storage()): string[] {
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(SEEN_JOBS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch { return []; }
}

export function markJobsSeen(ids: string[], store: StorageLike | null = storage()): string[] {
  const merged = Array.from(new Set([...readSeenJobIds(store), ...ids])).slice(-MAX_SEEN);
  try { store?.setItem(SEEN_JOBS_STORAGE_KEY, JSON.stringify(merged)); } catch { /* storage full or blocked: alert again rather than fail */ }
  return merged;
}

export function unseenJobIds(currentIds: string[], store: StorageLike | null = storage()): string[] {
  const seen = new Set(readSeenJobIds(store));
  return currentIds.filter((id) => !seen.has(id));
}

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioContext = audioContext ?? new Ctor();
  return audioContext;
}

/** Two-tone chime generated with the Web Audio API — no audio asset needed. */
export function playJobChime(): boolean {
  const context = getAudioContext();
  if (!context) return false;
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  const start = context.currentTime + 0.02;
  [[880, 0], [1318.5, 0.22], [880, 0.5], [1318.5, 0.72]].forEach(([frequency, offset]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.2);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.22);
  });
  return true;
}

export function vibrateForJob(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try { return navigator.vibrate([300, 150, 300, 150, 300]); } catch { return false; }
}

export type AlertPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationPermission(): AlertPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission as AlertPermission;
}

export function jobAlertsEnabled(store: StorageLike | null = storage()): boolean {
  try { return store?.getItem(ALERTS_ENABLED_KEY) === '1'; } catch { return false; }
}

/** Mobile browsers start audio suspended after every page load; resume it on the officer's first tap. */
export function unlockAudioOnFirstGesture(): () => void {
  if (typeof window === 'undefined' || !jobAlertsEnabled()) return () => undefined;
  const unlock = () => {
    const context = getAudioContext();
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  return () => window.removeEventListener('pointerdown', unlock);
}

/** Must run inside a user gesture: unlocks audio and asks for notification permission. */
export async function enableJobAlerts(store: StorageLike | null = storage()): Promise<AlertPermission> {
  const context = getAudioContext();
  if (context?.state === 'suspended') await context.resume().catch(() => undefined);
  playJobChime();
  try { store?.setItem(ALERTS_ENABLED_KEY, '1'); } catch { /* ignore */ }
  if (notificationPermission() === 'default') {
    try { await window.Notification.requestPermission(); } catch { /* older Safari: callback form only */ }
  }
  return notificationPermission();
}

export async function showJobNotification(title: string, body: string, url: string): Promise<boolean> {
  if (notificationPermission() !== 'granted') return false;
  const options: NotificationOptions = { body, tag: 'fcm-dispatch-job', icon: '/assets/pwa/ie-192.png', badge: '/assets/pwa/ie-192.png', data: { url } };
  try {
    const registration = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) { await registration.showNotification(title, { ...options, requireInteraction: true } as NotificationOptions); return true; }
    const notification = new window.Notification(title, options);
    notification.onclick = () => { window.focus(); window.location.assign(url); };
    return true;
  } catch { return false; }
}

/** Chime + vibrate + system notification for jobs that are new to this device. */
export function alertForNewJob(title: string, body: string, url: string): void {
  playJobChime();
  vibrateForJob();
  void showJobNotification(title, body, url);
}
