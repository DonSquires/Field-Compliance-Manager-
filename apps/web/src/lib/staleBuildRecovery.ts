// After a deploy the host removes the previous build's chunks, so a tab that
// was open before the deploy cannot lazy-load a page. Reload once to pick up
// the new build; the stamp stops a reload loop if the chunk is genuinely broken.
const RELOAD_STAMP_KEY = 'fcm:stale-build-reload-at';
const RELOAD_COOLDOWN_MS = 60_000;

export function shouldReloadForStaleBuild(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now: number): boolean {
  try {
    const stamp = storage?.getItem(RELOAD_STAMP_KEY);
    const last = stamp == null ? Number.NaN : Number(stamp);
    if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return false;
    storage?.setItem(RELOAD_STAMP_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

export function installStaleBuildRecovery(target: Window = window): void {
  target.addEventListener('vite:preloadError', (event) => {
    let storage: Storage | null = null;
    try { storage = target.sessionStorage; } catch { storage = null; }
    if (!shouldReloadForStaleBuild(storage, Date.now())) return;
    event.preventDefault();
    target.location.reload();
  });
}
