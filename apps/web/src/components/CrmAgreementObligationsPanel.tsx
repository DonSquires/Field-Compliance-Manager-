import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Plus, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementObligationsPanel.css';

export interface AgreementObligation {
  id: string;
  service_agreement_id: string;
  obligation_code: string | null;
  obligation_type: 'response_time' | 'patrol_frequency' | 'report_delivery' | 'incident_escalation' | 'compliance_check' | 'custom';
  description: string;
  sla_target_minutes: number | null;
  requires_proof: boolean;
  proof_artifact_type: 'photo' | 'gps_track' | 'report' | 'signature' | 'timestamp' | 'other' | null;
  escalation_minutes: number | null;
  escalation_contact: string | null;
  active: boolean;
  site_id: string | null;
  frequency_rule: { period?: string; minimum_count?: number } | null;
  updated_at: string;
}

interface CoveredSite {
  id: string;
  name: string;
  linked: boolean;
  link_status: string | null;
}

interface ObligationForm {
  code: string;
  type: AgreementObligation['obligation_type'];
  description: string;
  siteId: string;
  slaMinutes: string;
  requiresProof: boolean;
  proofType: NonNullable<AgreementObligation['proof_artifact_type']>;
  escalationMinutes: string;
  escalationContact: string;
  cadencePeriod: 'shift' | 'day' | 'week' | 'month';
  cadenceCount: string;
}

interface ProofArtifact {
  id: string;
  artifact_type: string;
  captured_at: string;
  notes: string | null;
  status: 'active' | 'withdrawn';
  created_at: string;
  updated_at: string;
  created_by_name: string;
  withdrawn_at: string | null;
  withdrawn_by_name: string | null;
  withdrawal_reason: string | null;
  metadata: {
    site_name?: string;
    officer_name?: string;
    arrived_at?: string;
    departed_at?: string;
    gps_point_count?: number;
  };
}

interface EligibleProofSource {
  source_record_id: string;
  site_name: string;
  officer_name: string;
  arrived_at: string;
  departed_at: string;
  artifact_type: string;
  gps_point_count: number;
}

interface ProofRegister {
  obligation_id: string;
  required_artifact_type: AgreementObligation['proof_artifact_type'];
  readiness: 'not_required' | 'configuration_required' | 'ready' | 'source_workflow_unavailable';
  readiness_message: string;
  artifacts: ProofArtifact[];
  eligible_sources: EligibleProofSource[];
}

const emptyForm: ObligationForm = {
  code: '',
  type: 'response_time',
  description: '',
  siteId: '',
  slaMinutes: '',
  requiresProof: false,
  proofType: 'timestamp',
  escalationMinutes: '',
  escalationContact: '',
  cadencePeriod: 'shift',
  cadenceCount: '1',
};

const obligationLabels: Record<AgreementObligation['obligation_type'], string> = {
  response_time: 'Response time',
  patrol_frequency: 'Patrol frequency',
  report_delivery: 'Report delivery',
  incident_escalation: 'Incident escalation',
  compliance_check: 'Compliance check',
  custom: 'Custom requirement',
};

const obligationBoundaries: Record<AgreementObligation['obligation_type'], string> = {
  response_time: 'Links the contract requirement to SLA evidence when dispatched work already carries a response target.',
  patrol_frequency: 'Records the minimum contracted cadence. It does not create roster work or patrol stops.',
  report_delivery: 'Records the delivery requirement. Report generation and delivery remain in Reporting.',
  incident_escalation: 'Records when and where an incident must be escalated.',
  compliance_check: 'Records the required check and its proof expectation.',
  custom: 'Records a contract requirement for review without inventing an automated workflow.',
};

export function CrmAgreementObligationsPanel({
  agreementId,
  sites,
  obligations,
  onSaved,
}: {
  agreementId: string;
  sites: CoveredSite[];
  obligations: AgreementObligation[];
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<AgreementObligation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ObligationForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const activeSites = sites.filter((site) => site.linked && site.link_status === 'active');
  const positiveNumber = (value: string) => value === '' || (Number.isInteger(Number(value)) && Number(value) > 0);
  const formValid =
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(form.code.trim()) &&
    form.description.trim().length > 0 &&
    positiveNumber(form.slaMinutes) &&
    positiveNumber(form.escalationMinutes) &&
    (form.type !== 'patrol_frequency' || (form.cadenceCount !== '' && positiveNumber(form.cadenceCount)));

  const startCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
    setNotice(null);
    requestId.current = crypto.randomUUID();
  };

  const startEdit = (obligation: AgreementObligation) => {
    setEditing(obligation);
    setForm({
      code: obligation.obligation_code ?? '',
      type: obligation.obligation_type,
      description: obligation.description,
      siteId: obligation.site_id ?? '',
      slaMinutes: obligation.sla_target_minutes == null ? '' : String(obligation.sla_target_minutes),
      requiresProof: obligation.requires_proof,
      proofType: obligation.proof_artifact_type ?? 'timestamp',
      escalationMinutes: obligation.escalation_minutes == null ? '' : String(obligation.escalation_minutes),
      escalationContact: obligation.escalation_contact ?? '',
      cadencePeriod: (obligation.frequency_rule?.period as ObligationForm['cadencePeriod']) ?? 'shift',
      cadenceCount: obligation.frequency_rule?.minimum_count == null ? '1' : String(obligation.frequency_rule.minimum_count),
    });
    setShowForm(true);
    setError(null);
    setNotice(null);
    setDeactivatingId(null);
    setEvidenceId(null);
    requestId.current = crypto.randomUUID();
  };

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setForm(emptyForm);
    requestId.current = crypto.randomUUID();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('manage_crm_agreement_obligation', {
      p_client_request_id: requestId.current,
      p_agreement_id: agreementId,
      p_action: 'save',
      p_obligation_id: editing?.id ?? null,
      p_expected_updated_at: editing?.updated_at ?? null,
      p_obligation_code: form.code.trim().toUpperCase(),
      p_obligation_type: form.type,
      p_description: form.description.trim(),
      p_sla_target_minutes: form.slaMinutes ? Number(form.slaMinutes) : null,
      p_requires_proof: form.requiresProof,
      p_proof_artifact_type: form.requiresProof ? form.proofType : null,
      p_escalation_minutes: form.escalationMinutes ? Number(form.escalationMinutes) : null,
      p_escalation_contact: form.escalationContact.trim() || null,
      p_site_id: form.siteId || null,
      p_frequency_rule: form.type === 'patrol_frequency'
        ? { period: form.cadencePeriod, minimum_count: Number(form.cadenceCount) }
        : null,
    });
    if (saveError) {
      setError(saveError.message);
    } else {
      await onSaved();
      setNotice(editing ? 'Contract requirement updated with an audit receipt.' : 'Contract requirement added with an audit receipt.');
      closeForm();
    }
    setSaving(false);
  };

  const deactivate = async (obligation: AgreementObligation) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: deactivateError } = await supabase.rpc('manage_crm_agreement_obligation', {
      p_client_request_id: crypto.randomUUID(),
      p_agreement_id: agreementId,
      p_action: 'deactivate',
      p_obligation_id: obligation.id,
      p_expected_updated_at: obligation.updated_at,
      p_obligation_code: null,
      p_obligation_type: null,
      p_description: null,
      p_sla_target_minutes: null,
      p_requires_proof: false,
      p_proof_artifact_type: null,
      p_escalation_minutes: null,
      p_escalation_contact: null,
      p_site_id: null,
      p_frequency_rule: null,
    });
    if (deactivateError) {
      setError(deactivateError.message);
    } else {
      await onSaved();
      setNotice(`${obligation.obligation_code ?? 'Contract requirement'} deactivated. Historical evidence remains available.`);
      setDeactivatingId(null);
    }
    setSaving(false);
  };

  return <section className="agreement-obligations" aria-labelledby="agreement-obligations-title">
    <div className="agreement-section-heading">
      <div>
        <h3 id="agreement-obligations-title">Contract requirements</h3>
        <p>Define the measurable requirement, covered Site, evidence, and escalation before field work begins.</p>
      </div>
      {!showForm && <button type="button" onClick={startCreate}><Plus size={15} />Add requirement</button>}
    </div>
    <div className="agreement-obligation-boundary">
      <strong>Automation boundary</strong>
      <span>These records govern contract evidence. They do not create shifts, patrol stops, reports, notifications, or officer post orders by themselves.</span>
    </div>
    {error && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="agreement-obligation-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {showForm && <form className="agreement-obligation-form" onSubmit={save}>
      <header><div><strong>{editing ? `Edit ${editing.obligation_code}` : 'Add contract requirement'}</strong><span>{obligationBoundaries[form.type]}</span></div><button type="button" onClick={closeForm} aria-label="Cancel requirement editing"><X size={16} /></button></header>
      <div className="agreement-obligation-grid">
        <label><span>Requirement code</span><input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="PATROL.DAILY" /></label>
        <label><span>Requirement type</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as AgreementObligation['obligation_type'] })}>{Object.entries(obligationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Covered Site</span><select value={form.siteId} onChange={(event) => setForm({ ...form, siteId: event.target.value })}><option value="">All covered Sites</option>{activeSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label><span>SLA target, minutes</span><input type="number" min="1" step="1" value={form.slaMinutes} onChange={(event) => setForm({ ...form, slaMinutes: event.target.value })} /></label>
        {form.type === 'patrol_frequency' && <><label><span>Minimum patrols</span><input required type="number" min="1" step="1" value={form.cadenceCount} onChange={(event) => setForm({ ...form, cadenceCount: event.target.value })} /></label><label><span>Cadence</span><select value={form.cadencePeriod} onChange={(event) => setForm({ ...form, cadencePeriod: event.target.value as ObligationForm['cadencePeriod'] })}><option value="shift">Per shift</option><option value="day">Per day</option><option value="week">Per week</option><option value="month">Per month</option></select></label></>}
        <label className="is-wide"><span>Requirement description</span><textarea required rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label className="agreement-obligation-check"><input type="checkbox" checked={form.requiresProof} onChange={(event) => setForm({ ...form, requiresProof: event.target.checked })} /><span>Evidence is required</span></label>
        {form.requiresProof && <label><span>Required evidence</span><select value={form.proofType} onChange={(event) => setForm({ ...form, proofType: event.target.value as ObligationForm['proofType'] })}><option value="timestamp">Timestamp</option><option value="photo">Photo</option><option value="gps_track">GPS track</option><option value="report">Report</option><option value="signature">Signature</option><option value="other">Other</option></select></label>}
        <label><span>Escalate after, minutes</span><input type="number" min="1" step="1" value={form.escalationMinutes} onChange={(event) => setForm({ ...form, escalationMinutes: event.target.value })} /></label>
        <label className="is-wide"><span>Escalation contact or instruction</span><input value={form.escalationContact} onChange={(event) => setForm({ ...form, escalationContact: event.target.value })} /></label>
      </div>
      <footer><button type="button" onClick={closeForm}>Cancel</button><button type="submit" disabled={saving || !formValid}>{saving ? 'Saving…' : editing?.active === false ? 'Save and reactivate' : 'Save requirement'}</button></footer>
    </form>}
    {!showForm && obligations.length === 0 ? <div className="agreement-setup-empty">No contract requirements have been configured. Add one only when the agreement names a measurable obligation.</div> : !showForm && <div className="agreement-obligation-list">{obligations.map((obligation) => {
      const siteName = sites.find((site) => site.id === obligation.site_id)?.name ?? 'All covered Sites';
      const cadence = obligation.obligation_type === 'patrol_frequency' && obligation.frequency_rule
        ? `${obligation.frequency_rule.minimum_count} per ${obligation.frequency_rule.period}`
        : null;
      const proofLabel = obligation.proof_artifact_type === 'gps_track'
        ? 'GPS track'
        : obligation.proof_artifact_type?.replaceAll('_', ' ') ?? 'Evidence type not configured';
      return <article key={obligation.id} className={obligation.active ? '' : 'is-inactive'} aria-label={`${obligation.obligation_code} ${obligation.active ? 'active' : 'inactive'}`}>
        <div><span>{obligationLabels[obligation.obligation_type]}</span><strong>{obligation.obligation_code}</strong><p>{obligation.description}</p><small>{siteName}{cadence ? ` · ${cadence}` : ''}{obligation.sla_target_minutes ? ` · ${obligation.sla_target_minutes} minute target` : ''}{obligation.requires_proof ? ` · ${proofLabel} proof required` : ''}</small></div>
        <span className={`agreement-obligation-state ${obligation.active ? 'is-active' : ''}`}>{obligation.active ? 'Active' : 'Inactive'}</span>
        <div className="agreement-obligation-actions">
          <button type="button" disabled={saving} onClick={() => startEdit(obligation)}>{obligation.active ? 'Edit' : 'Edit and reactivate'}</button>
          {obligation.requires_proof && <button type="button" disabled={saving} onClick={() => setEvidenceId(evidenceId === obligation.id ? null : obligation.id)}><Link2 size={14} />{evidenceId === obligation.id ? 'Close evidence' : 'Evidence register'}</button>}
          {obligation.active && (deactivatingId === obligation.id ? <><button type="button" className="is-danger" disabled={saving} onClick={() => void deactivate(obligation)}>Confirm deactivate</button><button type="button" disabled={saving} onClick={() => setDeactivatingId(null)}>Cancel</button></> : <button type="button" className="is-danger" disabled={saving} onClick={() => setDeactivatingId(obligation.id)}>Deactivate</button>)}
        </div>
        {evidenceId === obligation.id && <ObligationEvidenceRegister obligation={obligation} />}
      </article>;
    })}</div>}
  </section>;
}

function ObligationEvidenceRegister({ obligation }: { obligation: AgreementObligation }) {
  const [register, setRegister] = useState<ProofRegister | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase.rpc('get_crm_obligation_proof_register', {
      p_obligation_id: obligation.id,
    });
    if (loadError) setError(loadError.message);
    else setRegister(data as ProofRegister);
    setLoading(false);
  }, [obligation.id]);

  useEffect(() => { void load(); }, [load]);

  const attach = async (source: EligibleProofSource) => {
    setBusyId(source.source_record_id);
    setError(null);
    setNotice(null);
    const { error: attachError } = await supabase.rpc('manage_crm_obligation_proof', {
      p_action: 'attach_shift_stop',
      p_obligation_id: obligation.id,
      p_client_request_id: crypto.randomUUID(),
      p_source_record_id: source.source_record_id,
      p_artifact_id: null,
      p_expected_updated_at: null,
      p_notes: notes[source.source_record_id]?.trim() || null,
      p_withdrawal_reason: null,
    });
    if (attachError) setError(attachError.message);
    else {
      setNotice('Evidence linked with a review receipt.');
      await load();
    }
    setBusyId(null);
  };

  const withdraw = async (artifact: ProofArtifact) => {
    setBusyId(artifact.id);
    setError(null);
    setNotice(null);
    const { error: withdrawError } = await supabase.rpc('manage_crm_obligation_proof', {
      p_action: 'withdraw',
      p_obligation_id: obligation.id,
      p_client_request_id: crypto.randomUUID(),
      p_source_record_id: null,
      p_artifact_id: artifact.id,
      p_expected_updated_at: artifact.updated_at,
      p_notes: null,
      p_withdrawal_reason: withdrawalReason.trim(),
    });
    if (withdrawError) setError(withdrawError.message);
    else {
      setNotice('Evidence link withdrawn. Its history remains in the register.');
      setWithdrawId(null);
      setWithdrawalReason('');
      await load();
    }
    setBusyId(null);
  };

  return <section className="agreement-proof-register" aria-label={`${obligation.obligation_code} evidence register`}>
    <header>
      <div><strong>Evidence register</strong><span>Review completed work before linking it to this contract requirement.</span></div>
      <button type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'is-spinning' : ''} />Refresh</button>
    </header>
    {error && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="agreement-obligation-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {loading ? <div className="agreement-proof-loading"><RefreshCw size={16} className="is-spinning" />Loading evidence chain</div> : register && <>
      <div className={`agreement-proof-readiness is-${register.readiness}`}>
        <strong>{register.readiness === 'ready' ? 'Source check ready' : register.readiness === 'configuration_required' ? 'Configuration required' : register.readiness === 'not_required' ? 'Evidence not required' : 'Source workflow unavailable'}</strong>
        <span>{register.readiness_message}</span>
      </div>
      <div className="agreement-proof-section">
        <h4>Linked evidence <span>{register.artifacts.filter((artifact) => artifact.status === 'active').length} active</span></h4>
        {register.artifacts.length === 0 ? <p className="agreement-proof-empty">No evidence has been linked. The requirement remains unproven.</p> : register.artifacts.map((artifact) => <article key={artifact.id} className={artifact.status === 'withdrawn' ? 'is-withdrawn' : ''}>
          <div><strong>{proofArtifactLabel(artifact.artifact_type)}</strong><span>{artifact.metadata.site_name ?? 'Covered Site'} · {formatEvidenceTime(artifact.captured_at)}</span><small>Linked by {artifact.created_by_name} on {formatEvidenceTime(artifact.created_at)}{artifact.notes ? ` · ${artifact.notes}` : ''}</small></div>
          <span className={`agreement-proof-status is-${artifact.status}`}>{artifact.status}</span>
          {artifact.status === 'withdrawn' ? <p>Withdrawn by {artifact.withdrawn_by_name ?? 'a provider administrator'} on {artifact.withdrawn_at ? formatEvidenceTime(artifact.withdrawn_at) : 'an unknown date'} · {artifact.withdrawal_reason}</p> : withdrawId === artifact.id ? <div className="agreement-proof-withdraw"><label><span>Why is this link incorrect?</span><input value={withdrawalReason} onChange={(event) => setWithdrawalReason(event.target.value)} placeholder="Wrong requirement or source record" /></label><button type="button" className="is-danger" disabled={busyId === artifact.id || withdrawalReason.trim().length < 5} onClick={() => void withdraw(artifact)}>Confirm withdrawal</button><button type="button" disabled={busyId === artifact.id} onClick={() => { setWithdrawId(null); setWithdrawalReason(''); }}>Cancel</button></div> : <button type="button" className="is-danger agreement-proof-withdraw-trigger" onClick={() => setWithdrawId(artifact.id)}>Withdraw link</button>}
        </article>)}
      </div>
      <div className="agreement-proof-section">
        <h4>Eligible completed work <span>{register.eligible_sources.length}</span></h4>
        {register.readiness !== 'ready' ? <p className="agreement-proof-empty">Resolve the source check above before linking evidence.</p> : register.eligible_sources.length === 0 ? <p className="agreement-proof-empty">No unlinked completed work currently satisfies the agreement, Site, and evidence checks.</p> : register.eligible_sources.map((source) => <article key={source.source_record_id}>
          <div><strong>{source.site_name}</strong><span>{source.officer_name} · {formatEvidenceTime(source.arrived_at)} to {formatEvidenceTime(source.departed_at)}</span><small>{source.artifact_type === 'gps_track' ? `${source.gps_point_count} shift-linked GPS points` : 'Server-recorded arrival and departure'}</small></div>
          <label className="agreement-proof-note"><span>Review note (optional)</span><input value={notes[source.source_record_id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [source.source_record_id]: event.target.value }))} placeholder="Why this work proves the requirement" /></label>
          <button type="button" disabled={busyId === source.source_record_id} onClick={() => void attach(source)}>{busyId === source.source_record_id ? 'Linking…' : 'Link evidence'}</button>
        </article>)}
      </div>
    </>}
  </section>;
}

function formatEvidenceTime(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

function proofArtifactLabel(value: string): string {
  if (value === 'gps_track') return 'GPS track';
  if (value === 'arrival_timestamp') return 'Completed stop timestamp';
  return value.replaceAll('_', ' ');
}
