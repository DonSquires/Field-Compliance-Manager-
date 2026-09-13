/**
 * ReportsHubPage.tsx
 *
 * Canonical schema: breach_alerts (plate_number, breach_type, status, zone_id,
 * actioned_by/at, notes) and observations (plate_number, officer_id,
 * is_compliant, compliance_reason, zone_id, observed_at). There is no
 * severity/location_name/observation_type/reported_by column on either table
 * — those were a screen-first guess and have been removed.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
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
  generated_at: string | null;
  sent_at: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  agreement: Array<{ name: string }> | null;
}

const ReportsHubPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreement, selectedAgreementZones } = useServiceRelationships();
  const moduleContext = useActiveModuleContext('report');
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
  const [sendingPackId, setSendingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

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

      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
      const [breachResponse, observationResponse, packResponse, consolidatedResponse] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .in('zone_id', activeZoneIds)
              .gte('created_at', dateRange.start)
              .lte('created_at', dateRange.end)
              .order('created_at', { ascending: false })
          : supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .eq('organization_id', profile.organizationId)
              .gte('created_at', dateRange.start)
              .lte('created_at', dateRange.end)
              .order('created_at', { ascending: false }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, is_compliant, compliance_reason, zone_id')
              .in('zone_id', activeZoneIds)
              .gte('observed_at', dateRange.start)
              .lte('observed_at', dateRange.end)
              .order('observed_at', { ascending: false })
          : supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, is_compliant, compliance_reason, zone_id')
              .eq('organization_id', profile.organizationId)
              .gte('observed_at', dateRange.start)
              .lte('observed_at', dateRange.end)
              .order('observed_at', { ascending: false }),
        selectedAgreement?.id
          ? supabase
              .from('monthly_report_packs')
              .select('id, template_code, period_start, period_end, status, generated_at, sent_at, pdf_path, pdf_sha256, agreement:service_agreement_id(name)')
              .eq('service_agreement_id', selectedAgreement.id)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false })
          : supabase
              .from('monthly_report_packs')
              .select('id, template_code, period_start, period_end, status, generated_at, sent_at, pdf_path, pdf_sha256, agreement:service_agreement_id(name)')
              .eq('organization_id', profile.organizationId)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false }),
        selectedAgreement?.id
          ? supabase.rpc('get_consolidated_reporting_overview', { p_root_organization_id: profile.organizationId, p_service_agreement_id: selectedAgreement.id, p_from: dateRange.start, p_to: dateRange.end })
          : supabase.rpc('get_consolidated_reporting_overview', { p_root_organization_id: profile.organizationId, p_from: dateRange.start, p_to: dateRange.end }),
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
  }, [profile?.organizationId, selectedAgreement?.id, selectedAgreementZones, dateRange.end, dateRange.start]);

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
    setSendingPackId(pack.id);
    setError(null);
    setNotice(null);
    const { error: sendError } = await supabase.functions.invoke('send-report-pack', { body: { pack_id: pack.id } });
    if (sendError) setError(sendError.message);
    else { setNotice(`Report pack for ${pack.period_start} to ${pack.period_end} sent to the client contact.`); await loadReports(); }
    setSendingPackId(null);
  };

  const generateReportPackPdf = async (pack: MonthlyReportPack) => {
    setSendingPackId(pack.id);
    setError(null);
    setNotice(null);
    const { error: renderError } = await supabase.functions.invoke('generate-report-pack-pdf', { body: { pack_id: pack.id } });
    if (renderError) setError(renderError.message);
    else { setNotice(`PDF report pack for ${pack.period_start} to ${pack.period_end} is ready.`); await loadReports(); }
    setSendingPackId(null);
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
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <div className="reports-filter">
        <label>Date Range</label>
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
        <button type="button" className="btn btn-primary" onClick={() => void generateReportPacks()} disabled={generating}>{generating ? 'Generating...' : 'Generate report packs'}</button>
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
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead><tr><th>Agreement</th><th>Period</th><th>Template</th><th>Status</th><th>Generated</th><th>PDF</th><th>Delivery</th></tr></thead>
            <tbody>
              {reportPacks.length === 0 ? <tr><td colSpan={7} className="text-center">No report packs in this period</td></tr> : reportPacks.map((pack) => <tr key={pack.id}><td>{pack.agreement?.[0]?.name ?? 'Service agreement'}</td><td>{pack.period_start} to {pack.period_end}</td><td>{pack.template_code}</td><td><span className={`status-badge status-${pack.status}`}>{pack.status}</span></td><td>{pack.generated_at ? new Date(pack.generated_at).toLocaleString() : '-'}</td><td>{pack.pdf_path ? 'Ready' : <button type="button" className="btn btn-sm btn-secondary" onClick={() => void generateReportPackPdf(pack)} disabled={sendingPackId === pack.id}>{sendingPackId === pack.id ? 'Rendering...' : 'Generate PDF'}</button>}</td><td>{pack.status === 'sent' ? (pack.sent_at ? `Sent ${new Date(pack.sent_at).toLocaleString()}` : 'Sent') : <button type="button" className="btn btn-sm btn-primary" onClick={() => void sendReportPack(pack)} disabled={sendingPackId === pack.id}>{sendingPackId === pack.id ? 'Sending...' : 'Send to client'}</button>}</td></tr>)}
            </tbody>
          </table>
        </div>
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
                      {obs.is_compliant === null ? '—' : obs.is_compliant ? 'Yes' : 'No'}
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
