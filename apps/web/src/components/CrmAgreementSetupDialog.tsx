import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock3, MapPin, Plus, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementSetupDialog.css';
import './CrmAgreementObligations.css';

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

interface AgreementObligation {
  id: string;
  obligation_code: string;
  obligation_type: string;
  description: string;
  sla_target_minutes: number | null;
  requires_proof: boolean;
  proof_artifact_type: string | null;
  escalation_minutes: number | null;
  escalation_contact: string | null;
  site_id: string | null;
  frequency_rule: Record<string, unknown> | null;
  active: boolean;
  updated_at: string;
}

interface AgreementSetup {
  agreement: { id: string; name: string; invitation_status: string; enabled_modules: string[] };
  sites: AgreementSite[];
  modules: AgreementModule[];
  obligations: AgreementObligation[];
}

type SetupView = 'coverage' | 'modules' | 'obligations';

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
    else {
      const loaded = data as AgreementSetup;
      setSetup({ ...loaded, obligations: loaded.obligations ?? [] });
    }
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

  const saveObligation = async (obligation: AgreementObligation) => {
    setSavingKey(obligation.id); setError(null); setNotice(null);
    const isNew = obligation.id.startsWith('new-');
    const { error: actionError } = await supabase.rpc('manage_crm_agreement_obligation', {
      p_agreement_id: agreement.id, p_action: 'save', p_obligation_id: isNew ? null : obligation.id,
      p_expected_updated_at: isNew ? null : obligation.updated_at, p_obligation_code: obligation.obligation_code,
      p_obligation_type: obligation.obligation_type, p_description: obligation.description,
      p_sla_target_minutes: obligation.sla_target_minutes, p_requires_proof: obligation.requires_proof,
      p_proof_artifact_type: obligation.proof_artifact_type, p_escalation_minutes: obligation.escalation_minutes,
      p_escalation_contact: obligation.escalation_contact, p_site_id: obligation.site_id, p_frequency_rule: obligation.frequency_rule,
    });
    if (actionError) setError(actionError.message); else { await loadSetup(); setNotice('Agreement obligation saved.'); }
    setSavingKey(null);
  };

  const deactivateObligation = async (obligation: AgreementObligation) => {
    setSavingKey(obligation.id); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_agreement_obligation', { p_agreement_id: agreement.id, p_action: 'deactivate', p_obligation_id: obligation.id, p_expected_updated_at: obligation.updated_at });
    if (actionError) setError(actionError.message); else { await loadSetup(); setNotice('Agreement obligation deactivated.'); }
    setSavingKey(null);
  };

  const addObligation = () => setSetup((current) => current ? ({ ...current, obligations: [{ id: `new-${Date.now()}`, obligation_code: '', obligation_type: 'custom', description: '', sla_target_minutes: null, requires_proof: false, proof_artifact_type: null, escalation_minutes: null, escalation_contact: null, site_id: null, frequency_rule: null, active: true, updated_at: '' }, ...current.obligations] }) : current);

  return <div className="agreement-setup-backdrop"><section className="agreement-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="agreement-setup-title">
    <header><div><span>Operational contract setup</span><h2 id="agreement-setup-title">{agreement.name}</h2><p>{agreement.clientName} · {agreement.invitationStatus} agreement</p></div><button type="button" onClick={onClose} aria-label="Close agreement setup"><X size={18} /></button></header>
    {error && <div className="agreement-setup-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="agreement-setup-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <nav aria-label="Agreement setup sections"><button type="button" className={view === 'coverage' ? 'is-active' : ''} onClick={() => setView('coverage')}><MapPin size={16} />Covered sites {setup && <em>{setup.sites.filter((site) => site.linked && site.link_status === 'active').length}</em>}</button><button type="button" className={view === 'modules' ? 'is-active' : ''} onClick={() => setView('modules')}><Settings2 size={16} />Service modules {setup && <em>{setup.modules.filter((module) => module.enabled).length}</em>}</button><button type="button" className={view === 'obligations' ? 'is-active' : ''} onClick={() => setView('obligations')}><ClipboardCheck size={16} />Obligations {setup && <em>{setup.obligations.filter((obligation) => obligation.active).length}</em>}</button></nav>
    {loading && !setup ? <div className="agreement-setup-loading"><RefreshCw size={20} className="is-spinning" />Loading contract evidence</div> : setup && <main>
      {view === 'coverage' ? <section className="agreement-coverage"><div className="agreement-section-heading"><div><h3>Covered sites</h3><p>Choose the client places this contract authorizes. Boundary state remains visible and independent.</p></div></div><div>{setup.sites.length ? setup.sites.map((site) => { const active = site.linked && site.link_status === 'active'; return <article key={site.id}><span className={`agreement-site-icon is-${site.boundary_verification}`}><MapPin size={17} /></span><div><strong>{site.name}</strong><span>{site.address ?? 'Address not recorded'}</span><small>{site.boundary_verification === 'verified' ? <><ShieldCheck size={12} />Verified {site.boundary_status} boundary</> : <><Clock3 size={12} />{site.boundary_status} boundary requires review</>}</small></div><button type="button" className={active ? 'is-remove' : ''} disabled={savingKey === site.id} onClick={() => void runAction(site.id, active ? 'unlink_site' : 'link_site', { p_site_id: site.id })}>{savingKey === site.id ? 'Saving' : active ? 'Remove coverage' : 'Add coverage'}</button></article>; }) : <div className="agreement-setup-empty">No active client sites are available. Create and review a site before configuring coverage.</div>}</div></section> : view === 'modules' ? <section className="agreement-modules"><div className="agreement-section-heading"><div><h3>Service modules</h3><p>Set contract scope and operational handoff controls from the active module catalog.</p></div></div><div>{setup.modules.length ? setup.modules.map((module) => <ModuleRow key={module.module_key} module={module} saving={savingKey === module.module_key} onSave={(next) => void runAction(module.module_key, 'set_module', { p_module_key: module.module_key, p_enabled: next.enabled, p_sla_minutes: next.sla_minutes, p_allows_client_submission: next.allows_client_submission, p_allows_auto_dispatch: next.allows_auto_dispatch })} />) : <div className="agreement-setup-empty">No active service modules are available in the catalog.</div>}</div></section> : <section className="agreement-obligations"><div className="agreement-section-heading"><div><h3>Contract obligations</h3><p>Maintain stable report codes, service targets, proof requirements, and escalation ownership.</p></div><button type="button" onClick={addObligation}><Plus size={14} />Add obligation</button></div><div>{setup.obligations.length ? setup.obligations.map((obligation) => <ObligationRow key={obligation.id} obligation={obligation} sites={setup.sites.filter((site) => site.linked && site.link_status === 'active')} saving={savingKey === obligation.id} onSave={(next) => void saveObligation(next)} onDeactivate={() => void deactivateObligation(obligation)} />) : <div className="agreement-setup-empty">No obligations are configured for this agreement.</div>}</div></section>}
    </main>}
    <footer><span>Changes are tenant-scoped and recorded in the audit log.</span><button type="button" onClick={onClose}>Done</button></footer>
  </section></div>;
}

function ModuleRow({ module, saving, onSave }: { module: AgreementModule; saving: boolean; onSave: (module: AgreementModule) => void }) {
  const [draft, setDraft] = useState(module);
  useEffect(() => setDraft(module), [module]);
  return <article aria-label={`Module ${module.module_key.replaceAll('_', ' ')}`} className={draft.enabled ? 'is-enabled' : ''}><div className="agreement-module-title"><span><Settings2 size={16} /></span><div><strong>{module.module_key.replaceAll('_', ' ')}</strong><small>{draft.enabled ? 'Included in contract scope' : 'Not included'}</small></div><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>Enabled</span></label></div><div className="agreement-module-controls"><label><span>SLA minutes</span><input type="number" min="1" max="10080" value={draft.sla_minutes ?? ''} onChange={(event) => setDraft({ ...draft, sla_minutes: event.target.value ? Number(event.target.value) : null })} /></label><label className="agreement-check"><input type="checkbox" checked={draft.allows_client_submission} onChange={(event) => setDraft({ ...draft, allows_client_submission: event.target.checked })} /><span>Client submission</span></label><label className="agreement-check"><input type="checkbox" checked={draft.allows_auto_dispatch} onChange={(event) => setDraft({ ...draft, allows_auto_dispatch: event.target.checked })} /><span>Auto-dispatch</span></label><button type="button" disabled={saving} onClick={() => onSave(draft)}>{saving ? 'Saving' : 'Save module'}</button></div></article>;
}

function ObligationRow({ obligation, sites, saving, onSave, onDeactivate }: { obligation: AgreementObligation; sites: AgreementSite[]; saving: boolean; onSave: (obligation: AgreementObligation) => void; onDeactivate: () => void }) {
  const [draft, setDraft] = useState(obligation);
  useEffect(() => setDraft(obligation), [obligation]);
  return <article className={draft.active ? 'is-enabled' : ''}><div className="agreement-obligation-grid"><label><span>Stable code</span><input value={draft.obligation_code} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, obligation_code: event.target.value.toUpperCase() })} placeholder="PATROL.WEEKLY" /></label><label><span>Type</span><select value={draft.obligation_type} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, obligation_type: event.target.value })}><option value="response_time">Response time</option><option value="patrol_frequency">Patrol frequency</option><option value="report_delivery">Report delivery</option><option value="incident_escalation">Incident escalation</option><option value="compliance_check">Compliance check</option><option value="custom">Custom</option></select></label><label><span>Covered site</span><select value={draft.site_id ?? ''} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, site_id: event.target.value || null })}><option value="">Agreement-wide</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label className="is-wide"><span>Description</span><input value={draft.description} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label><span>SLA minutes</span><input type="number" min="1" value={draft.sla_target_minutes ?? ''} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, sla_target_minutes: event.target.value ? Number(event.target.value) : null })} /></label><label><span>Escalate after</span><input type="number" min="1" value={draft.escalation_minutes ?? ''} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, escalation_minutes: event.target.value ? Number(event.target.value) : null })} /></label><label><span>Escalation contact</span><input value={draft.escalation_contact ?? ''} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, escalation_contact: event.target.value || null })} /></label><label className="agreement-check"><input type="checkbox" checked={draft.requires_proof} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, requires_proof: event.target.checked, proof_artifact_type: event.target.checked ? draft.proof_artifact_type ?? 'photo' : null })} /><span>Proof required</span></label>{draft.requires_proof && <label><span>Proof type</span><select value={draft.proof_artifact_type ?? 'photo'} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, proof_artifact_type: event.target.value })}><option value="photo">Photo</option><option value="gps_track">GPS track</option><option value="report">Report</option><option value="signature">Signature</option><option value="timestamp">Timestamp</option><option value="other">Other</option></select></label>}</div><div className="agreement-obligation-actions">{draft.active ? <><button type="button" disabled={saving} onClick={() => onSave(draft)}>{saving ? 'Saving' : 'Save obligation'}</button>{!draft.id.startsWith('new-') && <button type="button" className="is-remove" disabled={saving} onClick={onDeactivate}>Deactivate</button>}</> : <span>Inactive obligation retained for contract history</span>}</div></article>;
}