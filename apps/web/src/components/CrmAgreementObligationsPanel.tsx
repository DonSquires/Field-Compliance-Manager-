import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, X } from 'lucide-react';
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
        : obligation.proof_artifact_type?.replaceAll('_', ' ');
      return <article key={obligation.id} className={obligation.active ? '' : 'is-inactive'} aria-label={`${obligation.obligation_code} ${obligation.active ? 'active' : 'inactive'}`}>
        <div><span>{obligationLabels[obligation.obligation_type]}</span><strong>{obligation.obligation_code}</strong><p>{obligation.description}</p><small>{siteName}{cadence ? ` · ${cadence}` : ''}{obligation.sla_target_minutes ? ` · ${obligation.sla_target_minutes} minute target` : ''}{obligation.requires_proof ? ` · ${proofLabel} proof required` : ''}</small></div>
        <span className={`agreement-obligation-state ${obligation.active ? 'is-active' : ''}`}>{obligation.active ? 'Active' : 'Inactive'}</span>
        <div className="agreement-obligation-actions">
          <button type="button" disabled={saving} onClick={() => startEdit(obligation)}>{obligation.active ? 'Edit' : 'Edit and reactivate'}</button>
          {obligation.active && (deactivatingId === obligation.id ? <><button type="button" className="is-danger" disabled={saving} onClick={() => void deactivate(obligation)}>Confirm deactivate</button><button type="button" disabled={saving} onClick={() => setDeactivatingId(null)}>Cancel</button></> : <button type="button" className="is-danger" disabled={saving} onClick={() => setDeactivatingId(obligation.id)}>Deactivate</button>)}
        </div>
      </article>;
    })}</div>}
  </section>;
}
