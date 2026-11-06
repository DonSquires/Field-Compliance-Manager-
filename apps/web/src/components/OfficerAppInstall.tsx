import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import './OfficerAppInstall.css';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
const isInstallPrompt = (event: Event): event is InstallPrompt => 'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;
function installed() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches
    || ('standalone' in navigator && navigator.standalone === true));
}
export function OfficerAppInstall() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [isInstalled, setInstalled] = useState(installed);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  useEffect(() => {
    const before = (event: Event) => {
      if (!isInstallPrompt(event)) return;
      event.preventDefault(); setPrompt(event);
    };
    const finished = () => { setInstalled(true); setPrompt(null); setOpen(false); };
    window.addEventListener('beforeinstallprompt', before);
    window.addEventListener('appinstalled', finished);
    let active = true;
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/officer-sw.js', { scope: '/', updateViaCache: 'none' }).catch((failure: unknown) => {
        console.error('Officer app installation support failed', failure);
        if (active) setError('Install support could not be loaded. Reconnect and reload, or use your browser menu to add FCM to your home screen.');
      });
    }
    return () => { active = false; window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', finished); };
  }, []);
  const install = async () => {
    setOpen(true); setError(null); setNotice(null);
    if (!prompt) return;
    setBusy(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setPrompt(null);
      setNotice(choice.outcome === 'accepted' ? 'Installation requested. Follow the browser confirmation; the IE icon will open FCM.' : 'Installation cancelled. You can try again from your browser menu.');
    } catch (failure) {
      console.error('Officer app installation prompt failed', failure);
      setPrompt(null); setError('Installation was not confirmed. Use the browser menu below, or reload and try again.');
    } finally { setBusy(false); }
  };
  if (isInstalled) return <p className="officer-install officer-install-status" role="status">FCM is running as an installed app.</p>;
  return <section className="officer-install" aria-label="Install officer app">
    <button type="button" className="officer-install-button" onClick={() => void install()} disabled={busy}><Download size={20} aria-hidden="true" />{busy ? 'Opening installation...' : 'Install FCM on this phone'}</button>
    {error && <p role="alert">{error}</p>}
    {open && <div className="officer-install-help"><button type="button" onClick={() => setOpen(false)} aria-label="Close install instructions"><X size={18} /></button>
      <h2>Add the IE icon to your home screen</h2>
      {notice && <p role="status">{notice}</p>}
      <p>{ios ? 'Open FCM in Safari, tap Share, then Add to Home Screen and Add. Select Open as Web App if offered.' : 'In Chrome or Edge, open the browser menu and choose Install app or Add to Home screen, then confirm. Menu wording depends on your phone and browser.'}</p>
      <p>This installs the web app, not an APK or a home-screen widget. Camera and location still need your permission. It does not guarantee background GPS, lock-screen alerts, or offline submissions; phone/browser limits still apply.</p>
    </div>}
  </section>;
}
