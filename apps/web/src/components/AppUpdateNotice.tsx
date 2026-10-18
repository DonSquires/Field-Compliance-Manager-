import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import './AppUpdateNotice.css';

const CHECK_INTERVAL_MS = 5 * 60_000;
const runningBuild = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : '';

export async function fetchDeployedBuild(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { build?: unknown };
    return typeof body.build === 'string' && body.build ? body.build : null;
  } catch {
    return null;
  }
}

export function AppUpdateNotice({ fetcher }: { fetcher?: typeof fetch }) {
  const [deployed, setDeployed] = useState<string | null>(null);

  useEffect(() => {
    if (!runningBuild || import.meta.env.DEV) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      const build = await fetchDeployedBuild(fetcher);
      if (!cancelled && build && build !== runningBuild) setDeployed(build);
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fetcher]);

  if (!deployed) return null;
  return (
    <div className="app-update-notice" role="status" aria-live="polite">
      <span>A newer version of Field Compliance Manager is live ({deployed.slice(0, 7)}). Save any open work, then reload to use it.</span>
      <button type="button" onClick={() => window.location.reload()}><RefreshCw size={14} aria-hidden="true" /> Reload</button>
    </div>
  );
}
