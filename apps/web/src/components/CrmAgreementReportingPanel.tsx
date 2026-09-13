import { useEffect, useState } from 'react';
import { CheckCircle2, FileBarChart } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementReportingPanel.css';

const REPORT_MODULE_KEYS = [
  'patrol', 'freedom_camping', 'parking_enforcement', 'noise_control', 'smoke_complaints', 'biosecurity', 'access_control', 'static_guarding', 'ems', 'client_reporting',
] as const;

interface ReportingAgreement {
  id: string;
  invitation_status: string;
  client_portal_reports_enabled: boolean;
  monthly_report_template_code: string | null;
}

interface ReportTemplate {
  template_code: string;
  name: string;
  module_key: string;
}

export function CrmAgreementReportingPanel({
  agreement,
  templates,
  onSaved,
}: {
  agreement: ReportingAgreement;
  templates: ReportTemplate[];
  onSaved: () => void | Promise<void>;
}) {
  const [enabled, setEnabled] = useState(agreement.client_portal_reports_enabled);
  const [templateCode, setTemplateCode] = useState(agreement.monthly_report_template_code ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [newTemplateCode, setNewTemplateCode] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateModule, setNewTemplateModule] = useState<string>(REPORT_MODULE_KEYS[0]);

  useEffect(() => {
    setEnabled(agreement.client_portal_reports_enabled);
    setTemplateCode(agreement.monthly_report_template_code ?? '');
  }, [agreement.client_portal_reports_enabled, agreement.monthly_report_template_code]);

  const save = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_agreement_reporting', {
      p_agreement_id: agreement.id,
      p_expected_invitation_status: agreement.invitation_status,
      p_client_portal_reports_enabled: enabled,
      p_monthly_report_template_code: enabled ? templateCode : null,
    });
    if (actionError) setError(actionError.message);
    else {
      setNotice(enabled ? 'Client report delivery configured.' : 'Client report delivery disabled for this agreement.');
      await onSaved();
    }
    setSaving(false);
  };

  const createTemplate = async () => {
    if (!newTemplateCode.trim() || !newTemplateName.trim()) return;
    setCreatingTemplate(true); setError(null); setNotice(null);
    const { data, error: createError } = await supabase.rpc('manage_report_template', {
      p_agreement_id: agreement.id,
      p_module_key: newTemplateModule,
      p_template_code: newTemplateCode.trim(),
      p_name: newTemplateName.trim(),
    });
    if (createError) setError(createError.message);
    else {
      setNotice(`Report template "${newTemplateName.trim()}" saved for your organization.`);
      setTemplateCode((data as { template_code?: string })?.template_code ?? newTemplateCode.trim());
      setNewTemplateCode(''); setNewTemplateName('');
      await onSaved();
    }
    setCreatingTemplate(false);
  };

  return <section className="agreement-reporting" aria-label="Reporting delivery">
    <div className="agreement-section-heading"><div><h3>Reporting delivery</h3><p>Decide whether this contract sends monthly client reports. Activation requires either a valid provider template or an explicit off setting.</p></div></div>
    {error && <div className="agreement-setup-message is-error" role="alert">{error}</div>}
    {notice && <div className="agreement-setup-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    <article>
      <span className="agreement-site-icon"><FileBarChart size={17} /></span>
      <div>
        <strong>Monthly client report pack</strong>
        <span>{enabled ? 'Enabled for the client portal' : 'Disabled by contract'}</span>
        <small>{enabled ? 'Select the provider-owned template used for monthly delivery.' : 'No monthly template is required while delivery is disabled.'}</small>
      </div>
      <label className="agreement-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Client reports</span></label>
      <label><span>Template</span><select value={templateCode} disabled={!enabled || templates.length === 0} onChange={(event) => setTemplateCode(event.target.value)}><option value="">{templates.length === 0 ? 'No provider templates configured' : 'Select template'}</option>{templates.map((template) => <option key={template.template_code} value={template.template_code}>{template.name} · {template.module_key.replaceAll('_', ' ')}</option>)}</select></label>
      <button type="button" disabled={saving || (enabled && !templateCode)} onClick={() => void save()}>{saving ? 'Saving' : 'Save reporting'}</button>
    </article>
    <details className="agreement-template-create">
      <summary>Create a provider report template</summary>
      <div className="agreement-template-create-fields">
        <label><span>Module</span><select value={newTemplateModule} onChange={(event) => setNewTemplateModule(event.target.value)}>{REPORT_MODULE_KEYS.map((key) => <option key={key} value={key}>{key.replaceAll('_', ' ')}</option>)}</select></label>
        <label><span>Template code</span><input value={newTemplateCode} onChange={(event) => setNewTemplateCode(event.target.value)} placeholder="e.g. standard_monthly" /></label>
        <label><span>Display name</span><input value={newTemplateName} onChange={(event) => setNewTemplateName(event.target.value)} placeholder="e.g. Standard monthly summary" /></label>
        <button type="button" disabled={creatingTemplate || !newTemplateCode.trim() || !newTemplateName.trim()} onClick={() => void createTemplate()}>{creatingTemplate ? 'Saving' : 'Save template'}</button>
      </div>
    </details>
  </section>;
}
