import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, ExternalLink, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmOperationalReadinessDialog.css';

interface ReadinessDimension {
  key: string;
  label: string;
  status: 'ready' | 'blocked';
  detail: string;
  owner: string;
  destination: string;
}

interface OperationalReadiness {
  agreement_id: string;
  invitation_status: string;
  ready: boolean;
  dimensions: ReadinessDimension[];
}

export function CrmOperationalReadinessDialog({ agreement, onClose, onNavigate }: { agreement: { id: string; name: string; clientName: string }; onClose: () => void; onNavigate: (destination: string) => void }) {
  const [readiness, setReadiness] = useState<OperationalReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReadiness = async () => {
    setLoading(true); setError(null);
    const { data, error: loadError } = await supabase.rpc('get_crm_operational_readiness', { p_agreement_id: agreement.id });
    if (loadError || !data) setError(loadError?.message ?? 'Operational readiness evidence could not be loaded.');
    else setReadiness(data as OperationalReadiness);
    setLoading(false);
  };

  useEffect(() => { void loadReadiness(); }, [agreement.id]);

  const blockedCount = readiness?.dimensions.filter((dimension) => dimension.status === 'blocked').length ?? 0;

  return <div className="readiness-backdrop"><section className="readiness-dialog" role="dialog" aria-modal="true" aria-labelledby="readiness-title">
    <header><div><span>Activation evidence</span><h2 id="readiness-title">{agreement.name}</h2><p>{agreement.clientName}</p></div><button type="button" onClick={onClose} aria-label="Close readiness review"><X size={18} /></button></header>
    {error && <div className="readiness-message" role="alert"><AlertTriangle size={16} />{error}</div>}
    {loading && !readiness ? <div className="readiness-loading"><RefreshCw size={20} className="is-spinning" />Evaluating canonical records</div> : readiness && <main>
      <section className={`readiness-verdict is-${readiness.ready ? 'ready' : 'blocked'}`}><span>{readiness.ready ? <CheckCircle2 size={22} /> : <ClipboardCheck size={22} />}</span><div><strong>{readiness.ready ? 'Ready for activation review' : `${blockedCount} readiness ${blockedCount === 1 ? 'blocker' : 'blockers'}`}</strong><p>{readiness.ready ? 'Every current operational and commercial dimension has supporting evidence.' : 'Resolve each blocked owner before requesting activation. No percentage or inferred completion is used.'}</p></div></section>
      <div className="readiness-dimensions">{readiness.dimensions.map((dimension) => <article key={dimension.key} aria-label={`${dimension.label} ${dimension.status}`} className={`is-${dimension.status}`}><span>{dimension.status === 'ready' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div><strong>{dimension.label}</strong><p>{dimension.detail}</p><small>{dimension.owner}</small></div>{dimension.status === 'blocked' && <button type="button" onClick={() => { onClose(); onNavigate(dimension.destination); }}>Open owner <ExternalLink size={13} /></button>}</article>)}</div>
    </main>}
    <footer><span>Read-only evidence from contract, location, geofence, billing, roster, and reporting records.</span><div><button type="button" onClick={() => void loadReadiness()} disabled={loading}><RefreshCw size={14} />Refresh</button><button type="button" className="is-primary" onClick={onClose}>Done</button></div></footer>
  </section></div>;
}