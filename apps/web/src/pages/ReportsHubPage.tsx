/**
 * ReportsHubPage.tsx
 *
 * Canonical schema: breach_alerts (plate_number, breach_type, status, zone_id,
 * actioned_by/at, notes) and observations (plate_number, officer_id,
 * is_compliant, compliance_reason, zone_id, observed_at). There is no
 * severity/location_name/observation_type/reported_by column on either table
 * — those were a screen-first guess and have been removed.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { ReportPackReviewPanel, type ReportPackEditorial, type ReviewableReportPack } from '../components/ReportPackReviewPanel';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface BreachAlert {
  id: string;
  created_at: string;
  breach_type: string;
  status: string;
  plate_number: string;
  zone_id: string | null;
  notes: string | null;
}

interface Observation {
  id: string;
  observed_at: string;
  plate_number: string;
  officer_id: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  zone_id: string | null;
}

interface ReportMetrics {
  totalBreaches: number;
  totalObservations: number;
  nonCompliantObservations: number;
}
interface ConsolidatedReportingRow {
  source_organization_id: string;
  source_organization_name: string;
  breach_count: number;
  observation_count: number;
  non_compliant_observation_count: number;
  report_pack_count: number;
}

interface MonthlyReportPack {
  id: string;
  template_code: string;
  period_start: string;
  period_end: string;
  status: string;
  data: Record<string, unknown> | null;
  editorial: ReportPackEditorial | null;
  generated_at: string | null;
  updated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
  delivery_channel: 'portal' | 'email' | null;
  sent_at: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  // PostgREST embeds a to-one relation as an object; older fixtures send an array.
  agreement: { name: string } | Array<{ name: string }> | null;
}

function reportAgreementName(pack: MonthlyReportPack): string {
  return (Array.isArray(pack.agreement) ? pack.agreement[0]?.name : pack.agreement?.name) ?? 'Service agreement';
}

function reportStatusLabel(pack: MonthlyReportPack): string {
  if (pack.status === 'draft') return 'Needs review';
  if (pack.status === 'sent') return 'Sent';
  if (!pack.published_at) return 'Review required';
  if (pack.delivery_channel === 'portal') return 'Live in portal';
  return 'Approved';
}

function complianceLabel(value: boolean | null): string {
  if (value === null) return '—';
  return value ? 'Yes' : 'No';
}

interface ReportPackRowProps {
  pack: MonthlyReportPack;
  busy: boolean;
  onReview: () => void;
  onOpenPdf: () => void;
  onGeneratePdf: () => void;
  onSend: () => void;
}

function reportPdfAction(pack: MonthlyReportPack, busy: boolean, onOpenPdf: () => void, onGeneratePdf: () => void): React.ReactNode {
  if (pack.pdf_path) {
    return <button type="button" className="btn btn-sm btn-secondary" onClick={onOpenPdf} disabled={busy}>{busy ? 'Opening...' : 'Open PDF'}</button>;
  }
  if (pack.status === 'sent') return '-';
  return <button type="button" className="btn btn-sm btn-secondary" onClick={onGeneratePdf} disabled={busy}>{busy ? 'Rendering...' : 'Generate preview'}</button>;
}

function reportDeliveryAction(pack: MonthlyReportPack, busy: boolean, onSend: () => void): React.ReactNode {
  if (pack.status === 'sent') {
    return pack.sent_at ? `Sent ${new Date(pack.sent_at).toLocaleString()}` : 'Sent';
  }
  const isPublished = pack.status === 'generated' && Boolean(pack.published_at);
  if (isPublished && pack.delivery_channel === 'portal') return 'Available in client portal';
  if (isPublished && pack.delivery_channel === 'email') {
    return <button type="button" className="btn btn-sm btn-primary" onClick={onSend} disabled={busy}>{busy ? 'Sending...' : 'Send reviewed report'}</button>;
  }
  return 'Publish after review';
}

function reportReviewAction(pack: MonthlyReportPack, onReview: () => void): React.ReactNode {
  if (pack.status === 'sent') return 'Issued record';
  return <button type="button" className="btn btn-sm btn-secondary" onClick={onReview}>{pack.reviewed_at ? 'Edit review' : 'Review'}</button>;
}

function ReportPackRow({ pack, busy, onReview, onOpenPdf, onGeneratePdf, onSend }: ReportPackRowProps) {
  return (
    <tr>
      <td>{reportAgreementName(pack)}</td>
      <td>{pack.period_start} to {pack.period_end}</td>
      <td><span className={`status-badge status-${pack.status}`}>{reportStatusLabel(pack)}</span></td>
      <td>{reportReviewAction(pack, onReview)}</td>
      <td>{reportPdfAction(pack, busy, onOpenPdf, onGeneratePdf)}</td>
      <td>{reportDeliveryAction(pack, busy, onSend)}</td>
    </tr>
  );
}

function exclusiveEndIso(date: string): string {
  const end = new Date(`${date}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}

const ReportsHubPage: React.FC = () => {
  const { profile } = useAuth();
  const relationships = useServiceRelationships();
  // The hub filters by an agreement the reader chooses here, not by the app-wide place context.
  const [agreementFilterId, setAgreementFilterId] = useState('');
  const providerAgreements = useMemo(() => relationships.agreements.filter((agreement) => agreement.agreement_type === 'operational' && agreement.client_organization_id !== profile?.organizationId), [profile?.organizationId, relationships.agreements]);
  const selectedAgreement = useMemo(() => providerAgreements.find((agreement) => agreement.id === agreementFilterId) ?? null, [agreementFilterId, providerAgreements]);
  const [metrics, setMetrics] = useState<ReportMetrics>({
    totalBreaches: 0,
    totalObservations: 0,
    nonCompliantObservations: 0,
  });

  const [breachAlerts, setBreachAlerts] = useState<BreachAlert[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [reportPacks, setReportPacks] = useState<MonthlyReportPack[]>([]);
  const [consolidatedReporting, setConsolidatedReporting] = useState<ConsolidatedReportingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generatingRollup, setGeneratingRollup] = useState(false);
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [reviewingPackId, setReviewingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });
  const reviewingPack = useMemo(() => reportPacks.find((pack) => pack.id === reviewingPackId) ?? null, [reportPacks, reviewingPackId]);

  // ATLAS READS: breach_alerts, observations, monthly_report_packs
  const loadReports = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Reports are unavailable.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      let activeZoneIds: string[] | null = null;
      if (selectedAgreement) {
        const { data: links } = await supabase.from('service_agreement_locations').select('zone_id').eq('service_agreement_id', selectedAgreement.id).eq('status', 'active').not('zone_id', 'is', null);
        const zoneIds = (links ?? []).map((link) => link.zone_id as string);
        activeZoneIds = zoneIds.length > 0 ? zoneIds : null;
      }
      const timestampEndExclusive = exclusiveEndIso(dateRange.end);
      // Report packs belong to the agreement's provider, which is a branch under the Model A house; list the whole house.
      const { data: descendantOrgIds } = await supabase.rpc('get_descendant_organizations', { org_id: profile.organizationId });
      const houseOrgIds = [...new Set([profile.organizationId, ...(Array.isArray(descendantOrgIds) ? descendantOrgIds : [])])];
      const [breachResponse, observationResponse, packResponse, consolidatedResponse] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .in('zone_id', activeZoneIds)
              .gte('created_at', dateRange.start)
              .lt('created_at', timestampEndExclusive)
              .order('created_at', { ascending: false })
          : supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .eq('organization_id', profile.organizationId)
              .gte('created_at', dateRange.start)
              .lt('created_at', timestampEndExclusive)
              .order('created_at', { ascending: false }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, is_compliant, compliance_reason, zone_id')
              .in('zone_id', activeZoneIds)
              .gte('observed_at', dateRange.start)
              .lt('observed_at', timestampEndExclusive)
              .order('observed_at', { ascending: false })
          : supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, is_compliant, compliance_reason, zone_id')
              .eq('organization_id', profile.organizationId)
              .gte('observed_at', dateRange.start)
              .lt('observed_at', timestampEndExclusive)
              .order('observed_at', { ascending: false }),
        selectedAgreement?.id
          ? supabase
              .from('monthly_report_packs')
              .select('id, template_code, period_start, period_end, status, data, editorial, generated_at, updated_at, reviewed_at, published_at, delivery_channel, sent_at, pdf_path, pdf_sha256, agreement:service_agreement_id(name)')
              .eq('service_agreement_id', selectedAgreement.id)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false })
          : supabase
              .from('monthly_report_packs')
              .select('id, template_code, period_start, period_end, status, data, editorial, generated_at, updated_at, reviewed_at, published_at, delivery_channel, sent_at, pdf_path, pdf_sha256, agreement:service_agreement_id(name)')
              .in('organization_id', houseOrgIds)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false }),
        // The overview is per branch of the house; there is no per-agreement overload (calling one 404'd and failed the whole page).
        supabase.rpc('get_consolidated_reporting_overview', { p_root_organization_id: profile.organizationId, p_from: dateRange.start, p_to: dateRange.end }),
      ]);

      const failure = breachResponse.error ?? observationResponse.error ?? packResponse.error ?? consolidatedResponse.error;
      if (failure) throw failure;
      const breaches = (breachResponse.data as BreachAlert[]) || [];
      const obs = (observationResponse.data as Observation[]) || [];
      setBreachAlerts(breaches);
      setObservations(obs);
      setReportPacks((packResponse.data as MonthlyReportPack[]) || []);
      setConsolidatedReporting((consolidatedResponse.data as ConsolidatedReportingRow[]) || []);
      setMetrics({ totalBreaches: breaches.length, totalObservations: obs.length, nonCompliantObservations: obs.filter((o) => o.is_compliant === false).length });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, selectedAgreement, dateRange.end, dateRange.start]);

  useEffect(() => { void loadReports(); }, [loadReports]);

  const generateReportPacks = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    const { data, error: generationError } = await supabase.rpc('generate_due_report_packs', { p_period_start: dateRange.start, p_period_end: dateRange.end });
    if (generationError || typeof data !== 'number') setError(generationError?.message ?? 'Report pack generation was not confirmed.');
    else { setNotice(`${data} report packs generated for the selected period.`); await loadReports(); }
    setGenerating(false);
  };

  const sendReportPack = async (pack: MonthlyReportPack) => {
    setBusyPackId(pack.id);
    setError(null);
    setNotice(null);
    const { error: sendError } = await supabase.functions.invoke('send-report-pack', { body: { pack_id: pack.id } });
    if (sendError) setError(sendError.message);
    else { setNotice(`Report pack for ${pack.period_start} to ${pack.period_end} sent to the client contact.`); await loadReports(); }
    setBusyPackId(null);
  };

  const generateReportPackPdf = async (pack: MonthlyReportPack) => {
    setBusyPackId(pack.id);
    setError(null);
    setNotice(null);
    const { error: renderError } = await supabase.functions.invoke('generate-report-pack-pdf', { body: { pack_id: pack.id } });
    if (renderError) setError(renderError.message);
    else { setNotice(`PDF preview for ${pack.period_start} to ${pack.period_end} is ready to review.`); await loadReports(); }
    setBusyPackId(null);
  };

  const openReportPackPdf = async (pack: MonthlyReportPack) => {
    if (!pack.pdf_path) return;
    setBusyPackId(pack.id);
    setError(null);
    const { data, error: signedError } = await supabase.storage.from('bob-uploads').createSignedUrl(pack.pdf_path, 900);
    if (signedError || !data?.signedUrl) setError(signedError?.message ?? 'The PDF preview could not be opened.');
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    setBusyPackId(null);
  };

  const finishReview = async (message: string) => {
    setNotice(message);
    setError(null);
    setReviewingPackId(null);
    await loadReports();
  };

  const generateDailyRollup = async () => {
    setGeneratingRollup(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('generate-daily-operational-rollup');
      if (invokeError || !data?.ok) {
        setError(invokeError?.message ?? data?.error ?? 'Daily operational rollup draft could not be generated.');
      } else {
        setNotice(`Daily operational rollup draft generated ("${data.draft.title}"). It has been submitted for human review in Approvals.`);
        await loadReports();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Daily rollup generation failed.');
    } finally {
      setGeneratingRollup(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading reports...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container reports-hub-page">
      <header className="page-header">
        <h1>Reports & Analytics</h1>
        <p className="subtitle">Compliance metrics, breach alerts, vehicle observations</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {notice && <output className="alert alert-success">{notice}</output>}

      <div className="reports-filter">
        {providerAgreements.length > 0 && (
          <label className="reports-agreement-filter">
            <span>Agreement</span>
            <select value={agreementFilterId} onChange={(event) => setAgreementFilterId(event.target.value)}>
              <option value="">All agreements ({providerAgreements.length})</option>
              {providerAgreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.client_name ? `${agreement.client_name} · ` : ''}{agreement.name}</option>)}
            </select>
          </label>
        )}
        <span className="reports-filter-label">Date range</span>
        <div className="date-inputs">
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            max={dateRange.end}
          />
          <span>to</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            min={dateRange.start}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void generateReportPacks()} disabled={generating}>{generating ? 'Generating...' : 'Generate report drafts'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => void generateDailyRollup()} disabled={generatingRollup}>{generatingRollup ? 'Generating rollup...' : 'Generate daily rollup'}</button>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalBreaches}</div>
          <div className="kpi-label">Breach Alerts</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalObservations}</div>
          <div className="kpi-label">Observations</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.nonCompliantObservations}</div>
          <div className="kpi-label">Non-Compliant</div>
          <div className="kpi-unit">observations</div>
        </div>
      </div>

      {consolidatedReporting.length > 1 && <section className="reports-section"><h2>Group Reporting Overview</h2><p className="subtitle">Branch-owned operational activity, consolidated for parent oversight. Detailed queues below remain in the current organization context.</p><div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Operating Organization</th><th>Breach Alerts</th><th>Observations</th><th>Non-Compliant</th><th>Report Packs</th></tr></thead><tbody>{consolidatedReporting.map((row) => <tr key={row.source_organization_id}><td>{row.source_organization_name}</td><td>{row.breach_count}</td><td>{row.observation_count}</td><td>{row.non_compliant_observation_count}</td><td>{row.report_pack_count}</td></tr>)}</tbody></table></div></section>}

      <section className="reports-section">
        <h2>Monthly Report Packs ({reportPacks.length})</h2>
        <p className="subtitle">Generated evidence remains an internal draft until a provider administrator reviews and publishes it.</p>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead><tr><th>Agreement</th><th>Period</th><th>Status</th><th>Review</th><th>PDF</th><th>Delivery</th></tr></thead>
            <tbody>
              {reportPacks.length === 0 ? <tr><td colSpan={6} className="text-center">No report packs in this period</td></tr> : reportPacks.map((pack) => (
                <ReportPackRow
                  key={pack.id}
                  pack={pack}
                  busy={busyPackId === pack.id}
                  onReview={() => setReviewingPackId(pack.id)}
                  onOpenPdf={() => void openReportPackPdf(pack)}
                  onGeneratePdf={() => void generateReportPackPdf(pack)}
                  onSend={() => void sendReportPack(pack)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {reviewingPack && <ReportPackReviewPanel pack={{ ...reviewingPack, agreementName: reportAgreementName(reviewingPack) } as ReviewableReportPack} onClose={() => setReviewingPackId(null)} onSaved={finishReview} />}
      </section>

      <section className="reports-section">
        <h2>Recent Breach Alerts ({breachAlerts.length})</h2>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Plate</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {breachAlerts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center">
                    No breach alerts in this period
                  </td>
                </tr>
              ) : (
                breachAlerts.slice(0, 10).map((breach) => (
                  <tr key={breach.id}>
                    <td>{new Date(breach.created_at).toLocaleString()}</td>
                    <td>
                      <span className="badge">{breach.breach_type}</span>
                    </td>
                    <td>{breach.plate_number}</td>
                    <td>
                      <span className={`status-badge status-${breach.status}`}>{breach.status}</span>
                    </td>
                    <td className="text-truncate" title={breach.notes || ''}>
                      {breach.notes ? breach.notes.substring(0, 50) : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="reports-section">
        <h2>Vehicle Observations ({observations.length})</h2>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Plate</th>
                <th>Compliant</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {observations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center">
                    No observations in this period
                  </td>
                </tr>
              ) : (
                observations.slice(0, 10).map((obs) => (
                  <tr key={obs.id}>
                    <td>{new Date(obs.observed_at).toLocaleString()}</td>
                    <td>{obs.plate_number}</td>
                    <td>
                      {complianceLabel(obs.is_compliant)}
                    </td>
                    <td>{obs.compliance_reason ?? '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default ReportsHubPage;
