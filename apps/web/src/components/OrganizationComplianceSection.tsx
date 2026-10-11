import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, CalendarClock, FileCheck2, Pencil, Plus, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { OrgProfile } from '../pages/OrganizationSetupPage';

interface ComplianceRecord {
  id: string;
  record_type: string;
  name: string;
  reference_number: string | null;
  issuer: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  coverage_amount: number | null;
  currency: string;
  verification_status: string;
  source_name: string;
  source_as_of: string;
  source_notes: string | null;
  replaces_record_id: string | null;
  status: string;
  updated_at: string;
}

interface ComplianceForm {
  record_type: string;
  name: string;
  reference_number: string;
  issuer: string;
  effective_date: string;
  expiry_date: string;
  coverage_amount: string;
  currency: string;
  source_name: string;
  source_as_of: string;
  source_notes: string;
  replaces_record_id: string;
}

const EMPTY_COMPLIANCE_FORM: ComplianceForm = {
  record_type: 'company_licence',
  name: '',
  reference_number: '',
  issuer: '',
  effective_date: '',
  expiry_date: '',
  coverage_amount: '',
  currency: 'NZD',
  source_name: '',
  source_as_of: '',
  source_notes: '',
  replaces_record_id: '',
};

const RECORD_TYPE_LABELS: Record<string, string> = {
  company_licence: 'Company licence',
  insurance: 'Insurance',
  policy: 'Policy',
  prequalification: 'Prequalification',
  registration: 'Registration',
  certification: 'Certification',
  other: 'Other',
};

function formatDate(value: string | null): string {
  if (!value) return 'No expiry';
  return new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`));
}

function dateInputValue(value: string | null): string {
  if (!value) return '';
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? '';
}

function expiryState(expiryDate: string | null): 'expired' | 'due' | 'current' | 'none' {
  if (!expiryDate) return 'none';
  const remaining = Math.ceil((new Date(`${expiryDate}T23:59:59`).getTime() - Date.now()) / 86_400_000);
  if (remaining < 0) return 'expired';
  if (remaining <= 60) return 'due';
  return 'current';
}

const OrganizationComplianceSection: React.FC<{
  org: OrgProfile;
  onOrgChange: (org: OrgProfile) => void;
}> = ({ org, onOrgChange }) => {
  const [corporate, setCorporate] = useState(org);
  const [records, setRecords] = useState<ComplianceRecord[]>([]);
  const [form, setForm] = useState<ComplianceForm>(EMPTY_COMPLIANCE_FORM);
  const [editing, setEditing] = useState<ComplianceRecord | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setCorporate(org), [org]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase
      .from('organization_compliance_records')
      .select('id, record_type, name, reference_number, issuer, effective_date, expiry_date, coverage_amount, currency, verification_status, source_name, source_as_of, source_notes, replaces_record_id, status, updated_at')
      .eq('organization_id', org.id)
      .order('status')
      .order('expiry_date', { ascending: true, nullsFirst: false });
    if (loadError) {
      setError(loadError.message);
    } else {
      setRecords((data as ComplianceRecord[]) ?? []);
    }
    setLoading(false);
  }, [org.id]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const currentRecords = useMemo(() => records.filter((record) => record.status === 'current'), [records]);
  const readiness = useMemo(() => ({
    verified: currentRecords.filter((record) => record.verification_status === 'verified').length,
    expired: currentRecords.filter((record) => expiryState(record.expiry_date) === 'expired').length,
    due: currentRecords.filter((record) => expiryState(record.expiry_date) === 'due').length,
  }), [currentRecords]);

  const saveCorporateProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: saveError } = await supabase.rpc('update_organization_corporate_profile', {
      p_organization_id: org.id,
      p_expected_updated_at: corporate.updated_at,
      p_legal_name: corporate.legal_name,
      p_trading_name: corporate.trading_name,
      p_nzbn: corporate.nzbn,
      p_company_registration_number: corporate.company_registration_number,
      p_corporate_status: corporate.corporate_status,
      p_corporate_status_as_of: corporate.corporate_status_as_of,
      p_nzbn_entity_type: corporate.nzbn_entity_type,
      p_registered_office: corporate.registered_office,
      p_postal_address: corporate.postal_address,
      p_website_url: corporate.website_url,
      p_corporate_profile_source: corporate.corporate_profile_source,
    });
    if (saveError) {
      setError(saveError.message);
    } else if (data) {
      const saved = data as OrgProfile;
      setCorporate(saved);
      onOrgChange(saved);
      setNotice('Legal identity saved for review.');
    }
    setSaving(false);
  };

  const reviewCorporateProfile = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: reviewError } = await supabase.rpc('review_organization_corporate_profile', {
      p_organization_id: org.id,
      p_expected_updated_at: corporate.updated_at,
      p_decision: 'verified',
    });
    if (reviewError) {
      setError(reviewError.message);
    } else if (data) {
      const reviewed = data as OrgProfile;
      setCorporate(reviewed);
      onOrgChange(reviewed);
      setNotice('Legal identity verified.');
    }
    setSaving(false);
  };

  const resetComplianceForm = () => {
    setForm(EMPTY_COMPLIANCE_FORM);
    setEditing(null);
    setRequestId(crypto.randomUUID());
  };

  const editRecord = (record: ComplianceRecord) => {
    setEditing(record);
    setForm({
      record_type: record.record_type,
      name: record.name,
      reference_number: record.reference_number ?? '',
      issuer: record.issuer ?? '',
      effective_date: dateInputValue(record.effective_date),
      expiry_date: dateInputValue(record.expiry_date),
      coverage_amount: record.coverage_amount?.toString() ?? '',
      currency: record.currency,
      source_name: record.source_name,
      source_as_of: dateInputValue(record.source_as_of),
      source_notes: record.source_notes ?? '',
      replaces_record_id: '',
    });
    document.getElementById('org-compliance-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const saveComplianceRecord = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: saveError } = await supabase.rpc('save_organization_compliance_record', {
      p_client_request_id: requestId,
      p_organization_id: org.id,
      p_record_id: editing?.id ?? null,
      p_expected_updated_at: editing?.updated_at ?? null,
      p_record_type: form.record_type,
      p_name: form.name,
      p_reference_number: form.reference_number || null,
      p_issuer: form.issuer || null,
      p_effective_date: form.effective_date || null,
      p_expiry_date: form.expiry_date || null,
      p_coverage_amount: form.coverage_amount ? Number(form.coverage_amount) : null,
      p_currency: form.currency,
      p_evidence_document_id: null,
      p_source_name: form.source_name,
      p_source_as_of: form.source_as_of,
      p_source_notes: form.source_notes || null,
      p_replaces_record_id: editing ? null : form.replaces_record_id || null,
    });
    if (saveError) {
      setError(saveError.message);
    } else if (data) {
      setNotice(editing ? 'Compliance record updated and returned to review.' : 'Compliance record added for review.');
      resetComplianceForm();
      await loadRecords();
    }
    setSaving(false);
  };

  const verifyRecord = async (record: ComplianceRecord) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: reviewError } = await supabase.rpc('review_organization_compliance_record', {
      p_record_id: record.id,
      p_expected_updated_at: record.updated_at,
      p_decision: 'verified',
      p_review_notes: 'Reviewed in Organisation settings.',
    });
    if (reviewError) {
      setError(reviewError.message);
    } else {
      setNotice(`${record.name} verified.`);
      await loadRecords();
    }
    setSaving(false);
  };

  return (
    <section className="reports-section org-settings-section" id="org-compliance" aria-labelledby="org-compliance-title">
      <div className="org-settings-section-heading">
        <span>Ready to contract</span>
        <h2 id="org-compliance-title">Legal identity and compliance</h2>
        <p>Company identity, licences, insurance, policies, and prequalifications. Source evidence is recorded separately from human verification.</p>
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <div className="org-compliance-summary" aria-label="Compliance readiness summary">
        <div><strong>{currentRecords.length}</strong><span>Current records</span></div>
        <div><strong>{readiness.verified}</strong><span>Verified</span></div>
        <div className={readiness.due ? 'is-warning' : ''}><strong>{readiness.due}</strong><span>Due within 60 days</span></div>
        <div className={readiness.expired ? 'is-danger' : ''}><strong>{readiness.expired}</strong><span>Expired</span></div>
      </div>

      <form className="settings-form org-corporate-form" onSubmit={saveCorporateProfile}>
        <div className="org-compliance-subheading">
          <div><h3>Registered company identity</h3><p>Keep the source visible. Saving changed details always returns them to unverified.</p></div>
          <span className={`status-badge status-${corporate.corporate_profile_verification_status === 'verified' ? 'active' : 'inactive'}`}>
            {corporate.corporate_profile_verification_status}
          </span>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="org-legal-name">Legal name</label><input id="org-legal-name" required value={corporate.legal_name ?? ''} onChange={(event) => setCorporate({ ...corporate, legal_name: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="org-trading-name">Trading name</label><input id="org-trading-name" value={corporate.trading_name ?? ''} onChange={(event) => setCorporate({ ...corporate, trading_name: event.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="org-nzbn">NZBN</label><input id="org-nzbn" required inputMode="numeric" pattern="[0-9 ]{13,}" value={corporate.nzbn ?? ''} onChange={(event) => setCorporate({ ...corporate, nzbn: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="org-company-number">Company number</label><input id="org-company-number" required value={corporate.company_registration_number ?? ''} onChange={(event) => setCorporate({ ...corporate, company_registration_number: event.target.value })} /></div>
          <div className="form-group">
            <label htmlFor="org-entity-type">Entity type</label>
            <select id="org-entity-type" value={corporate.nzbn_entity_type ?? ''} onChange={(event) => setCorporate({ ...corporate, nzbn_entity_type: event.target.value })}>
              <option value="">Choose entity type</option>
              <option value="company">Company</option>
              <option value="sole_trader">Sole trader</option>
              <option value="partnership">Partnership</option>
              <option value="trust">Trust</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="org-corporate-status">Registry status</label>
            <select id="org-corporate-status" value={corporate.corporate_status ?? ''} onChange={(event) => setCorporate({ ...corporate, corporate_status: event.target.value })}>
              <option value="">Choose registry status</option>
              <option value="registered">Registered</option>
              <option value="in_liquidation">In liquidation</option>
              <option value="receivership">Receivership</option>
              <option value="removed">Removed</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div className="form-group"><label htmlFor="org-corporate-status-date">Status checked on</label><input id="org-corporate-status-date" type="date" value={dateInputValue(corporate.corporate_status_as_of)} onChange={(event) => setCorporate({ ...corporate, corporate_status_as_of: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="org-website">Website</label><input id="org-website" type="url" placeholder="https://" value={corporate.website_url ?? ''} onChange={(event) => setCorporate({ ...corporate, website_url: event.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="org-registered-office">Registered office</label><textarea id="org-registered-office" rows={2} value={corporate.registered_office ?? ''} onChange={(event) => setCorporate({ ...corporate, registered_office: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="org-postal-address">Postal address</label><textarea id="org-postal-address" rows={2} value={corporate.postal_address ?? ''} onChange={(event) => setCorporate({ ...corporate, postal_address: event.target.value })} /></div>
        </div>
        <div className="form-group"><label htmlFor="org-corporate-source">Registry/source evidence</label><input id="org-corporate-source" required placeholder="e.g. NZ Companies Register checked 10 Oct 2026" value={corporate.corporate_profile_source ?? ''} onChange={(event) => setCorporate({ ...corporate, corporate_profile_source: event.target.value })} /></div>
        <div className="org-settings-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save identity'}</button>
          {corporate.corporate_profile_verification_status !== 'verified' && <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void reviewCorporateProfile()}><BadgeCheck size={16} /> Verify identity</button>}
        </div>
      </form>

      <div className="org-compliance-subheading">
        <div><h3>Compliance register</h3><p>Expired evidence remains visible. Add a replacement rather than deleting history.</p></div>
      </div>
      {loading ? (
        <div className="loading-state org-settings-empty"><div className="spinner" /><p>Loading compliance records…</p></div>
      ) : currentRecords.length === 0 ? (
        <div className="empty-state org-settings-empty"><FileCheck2 size={22} /><p>No company compliance records yet. Add the first source-backed record below.</p></div>
      ) : (
        <ul className="org-compliance-list" aria-label="Company compliance records">
          {currentRecords.map((record) => {
            const expiry = expiryState(record.expiry_date);
            return (
              <li key={record.id} className={`org-compliance-card expiry-${expiry}`}>
                <div className="org-compliance-card-icon">{expiry === 'expired' ? <ShieldAlert size={18} /> : expiry === 'due' ? <CalendarClock size={18} /> : <FileCheck2 size={18} />}</div>
                <div className="org-compliance-card-body">
                  <div><span>{RECORD_TYPE_LABELS[record.record_type] ?? record.record_type}</span><h4>{record.name}</h4></div>
                  <p>{[record.issuer, record.reference_number].filter(Boolean).join(' · ') || 'No issuer or reference recorded'}</p>
                  <small>Expiry: {formatDate(record.expiry_date)} · Source: {record.source_name} ({formatDate(record.source_as_of)})</small>
                </div>
                <div className="org-compliance-card-actions">
                  <span className={`status-badge status-${record.verification_status === 'verified' ? 'active' : 'inactive'}`}>{record.verification_status}</span>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => editRecord(record)}><Pencil size={14} /> Edit</button>
                  {record.verification_status !== 'verified' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void verifyRecord(record)}><BadgeCheck size={14} /> Verify</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form className="settings-form org-compliance-form" id="org-compliance-form" onSubmit={saveComplianceRecord}>
        <div className="org-compliance-subheading">
          <div><h3>{editing ? `Edit ${editing.name}` : 'Add compliance evidence'}</h3><p>New or changed evidence remains unverified until a master reviews it.</p></div>
          {editing && <button type="button" className="btn btn-sm btn-secondary" onClick={resetComplianceForm}>Cancel edit</button>}
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="compliance-type">Type</label><select id="compliance-type" value={form.record_type} onChange={(event) => setForm({ ...form, record_type: event.target.value })}>{Object.entries(RECORD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="form-group"><label htmlFor="compliance-name">Record name</label><input id="compliance-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="compliance-reference">Reference or policy number</label><input id="compliance-reference" value={form.reference_number} onChange={(event) => setForm({ ...form, reference_number: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="compliance-issuer">Issuer or provider</label><input id="compliance-issuer" value={form.issuer} onChange={(event) => setForm({ ...form, issuer: event.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="compliance-effective">Effective date</label><input id="compliance-effective" type="date" value={form.effective_date} onChange={(event) => setForm({ ...form, effective_date: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="compliance-expiry">Expiry date</label><input id="compliance-expiry" type="date" value={form.expiry_date} onChange={(event) => setForm({ ...form, expiry_date: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="compliance-coverage">Coverage amount</label><input id="compliance-coverage" type="number" min="0" step="0.01" value={form.coverage_amount} onChange={(event) => setForm({ ...form, coverage_amount: event.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label htmlFor="compliance-source">Source file or register</label><input id="compliance-source" required value={form.source_name} onChange={(event) => setForm({ ...form, source_name: event.target.value })} /></div>
          <div className="form-group"><label htmlFor="compliance-source-date">Source checked on</label><input id="compliance-source-date" type="date" required value={form.source_as_of} onChange={(event) => setForm({ ...form, source_as_of: event.target.value })} /></div>
        </div>
        {!editing && currentRecords.length > 0 && <div className="form-group"><label htmlFor="compliance-replaces">Replaces an older record (optional)</label><select id="compliance-replaces" value={form.replaces_record_id} onChange={(event) => setForm({ ...form, replaces_record_id: event.target.value })}><option value="">No replacement</option>{currentRecords.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}</select></div>}
        <div className="form-group"><label htmlFor="compliance-notes">Source notes</label><textarea id="compliance-notes" rows={2} value={form.source_notes} onChange={(event) => setForm({ ...form, source_notes: event.target.value })} /></div>
        <div className="org-settings-actions"><button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim() || !form.source_name.trim() || !form.source_as_of}><Plus size={16} /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Add evidence'}</button></div>
      </form>
    </section>
  );
};

export default OrganizationComplianceSection;
