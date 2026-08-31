import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, MapPin, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementSetupDialog.css';

interface AgreementSite {
  id: string;
  name: string;
  address: string | null;
  boundary_status: string;
  boundary_verification: string;
  linked: boolean;
  link_status: string | null;
}

interface AgreementModule {
  module_key: string;
  enabled: boolean;
  sla_minutes: number | null;
  allows_client_submission: boolean;
  allows_auto_dispatch: boolean;
}

interface AgreementSetup {
  agreement: { id: string; name: string; invitation_status: string; enabled_modules: string[] };
  sites: AgreementSite[];
  modules: AgreementModule[];
}

type SetupView = 'coverage' | 'modules';

export function CrmAgreementSetupDialog({ agreement, onClose }: { agreement: { id: string; name: string; clientName: string; invitationStatus: string }; onClose: () => void }) {
  const [setup, setSetup] = useState<AgreementSetup | null>(null);
  const [view, setView] = useState<SetupView>('coverage');
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSetup = async () => {
    setLoading(true); setError(null);
    const { data, error: loadError } = await supabase.rpc('get_crm_agreement_setup', { p_agreement_id: agreement.id });
    if (loadError || !data) setError(loadError?.message ?? 'Agreement setup evidence could not be loaded.');
    else setSetup(data as AgreementSetup);
    setLoading(false);
  };

  useEffect(() => { void loadSetup(); }, [agreement.id]);

  const runAction = async (key: string, action: string, payload: Record<string, unknown>) => {
    if (!setup) return;
    setSavingKey(key); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_agreement_setup', {
      p_agreement_id: agreement.id,
      p_expected_invitation_status: setup.agreement.invitation_status,
      p_action: action,
      p_site_id: null,
      p_module_key: null,
      p_enabled: true,
      p_sla_minutes: null,
      p_allows_client_submission: false,
      p_allows_auto_dispatch: false,
      ...payload,
    });
    if (actionError) setError(actionError.message);
    else { await loadSetup(); setNotice(action === 'link_site' ? 'Covered site linked to the agreement.' : action === 'unlink_site' ? 'Covered site removed from active coverage.' : 'Service module settings saved.'); }
    setSavingKey(null);
  };

  return <div className="agreement-setup-backdrop"><section className="agreement-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="agreement-setup-title">
    <header><div><span>Operational contract setup</span><h2 id="agreement-setup-title">{agreement.name}</h2><p>{agreement.clientName} · {agreement.invitationStatus} agreement</p></div><button type="button" onClick={onClose} aria-label="Close agreement setup"><X size={18} /></button></header>
    {error && <div className="agreement-setup-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="agreement-setup-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <nav aria-label="Agreement setup sections"><button type="button" className={view === 'coverage' ? 'is-active' : ''} onClick={() => setView('coverage')}><MapPin size={16} />Covered sites {setup && <em>{setup.sites.filter((site) => site.linked && site.link_status === 'active').length}</em>}</button><button type="button" className={view === 'modules' ? 'is-active' : ''} onClick={() => setView('modules')}><Settings2 size={16} />Service modules {setup && <em>{setup.modules.filter((module) => module.enabled).length}</em>}</button></nav>
    {loading && !setup ? <div className="agreement-setup-loading"><RefreshCw size={20} className="is-spinning" />Loading contract evidence</div> : setup && <main>
      {view === 'coverage' ? <section className="agreement-coverage"><div className="agreement-section-heading"><div><h3>Covered sites</h3><p>Choose the client places this contract authorizes. Boundary state remains visible and independent.</p></div></div><div>{setup.sites.length ? setup.sites.map((site) => { const active = site.linked && site.link_status === 'active'; return <article key={site.id}><span className={`agreement-site-icon is-${site.boundary_verification}`}><MapPin size={17} /></span><div><strong>{site.name}</strong><span>{site.address ?? 'Address not recorded'}</span><small>{site.boundary_verification === 'verified' ? <><ShieldCheck size={12} />Verified {site.boundary_status} boundary</> : <><Clock3 size={12} />{site.boundary_status} boundary requires review</>}</small></div><button type="button" className={active ? 'is-remove' : ''} disabled={savingKey === site.id} onClick={() => void runAction(site.id, active ? 'unlink_site' : 'link_site', { p_site_id: site.id })}>{savingKey === site.id ? 'Saving' : active ? 'Remove coverage' : 'Add coverage'}</button></article>; }) : <div className="agreement-setup-empty">No active client sites are available. Create and review a site before configuring coverage.</div>}</div></section> : <section className="agreement-modules"><div className="agreement-section-heading"><div><h3>Service modules</h3><p>Set contract scope and operational handoff controls from the active module catalog.</p></div></div><div>{setup.modules.length ? setup.modules.map((module) => <ModuleRow key={module.module_key} module={module} saving={savingKey === module.module_key} onSave={(next) => void runAction(module.module_key, 'set_module', { p_module_key: module.module_key, p_enabled: next.enabled, p_sla_minutes: next.sla_minutes, p_allows_client_submission: next.allows_client_submission, p_allows_auto_dispatch: next.allows_auto_dispatch })} />) : <div className="agreement-setup-empty">No active service modules are available in the catalog.</div>}</div></section>}
    </main>}
    <footer><span>Changes are tenant-scoped and recorded in the audit log.</span><button type="button" onClick={onClose}>Done</button></footer>
  </section></div>;
}

function ModuleRow({ module, saving, onSave }: { module: AgreementModule; saving: boolean; onSave: (module: AgreementModule) => void }) {
  const [draft, setDraft] = useState(module);
  useEffect(() => setDraft(module), [module]);
  return <article aria-label={`Module ${module.module_key.replaceAll('_', ' ')}`} className={draft.enabled ? 'is-enabled' : ''}><div className="agreement-module-title"><span><Settings2 size={16} /></span><div><strong>{module.module_key.replaceAll('_', ' ')}</strong><small>{draft.enabled ? 'Included in contract scope' : 'Not included'}</small></div><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>Enabled</span></label></div><div className="agreement-module-controls"><label><span>SLA minutes</span><input type="number" min="1" max="10080" value={draft.sla_minutes ?? ''} onChange={(event) => setDraft({ ...draft, sla_minutes: event.target.value ? Number(event.target.value) : null })} /></label><label className="agreement-check"><input type="checkbox" checked={draft.allows_client_submission} onChange={(event) => setDraft({ ...draft, allows_client_submission: event.target.checked })} /><span>Client submission</span></label><label className="agreement-check"><input type="checkbox" checked={draft.allows_auto_dispatch} onChange={(event) => setDraft({ ...draft, allows_auto_dispatch: event.target.checked })} /><span>Auto-dispatch</span></label><button type="button" disabled={saving} onClick={() => onSave(draft)}>{saving ? 'Saving' : 'Save module'}</button></div></article>;
}