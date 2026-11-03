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
import { Download, FilePlus2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { ActivityRecordBrowser } from '../components/ActivityRecordBrowser';
import { RepeatSubjectsPanel } from '../components/RepeatSubjectsPanel';
import { CustomReportBuilder } from '../components/CustomReportBuilder';
import { ReportPackReviewPanel, type ReportPackEditorial, type ReviewableReportPack } from '../components/ReportPackReviewPanel';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { CURRENT_REPORT_PDF_RENDERER } from '../lib/reportPackRenderer';
import { draftSummaryIfEmpty, functionErrorMessage, runIncidentScan, runPrivacyCheck } from '../lib/reportBob';
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
  plate_number: string | null;
  officer_id: string | null;
  subject_kind: 'vehicle' | 'person' | 'mixed' | 'place' | 'other';
  is_compliant: boolean | null;
  compliance_reason: string | null;
  zone_id: string | null;
}

interface ReportMetrics {
  totalBreaches: number;
  totalObservations: number;
  nonCompliantObservations: number;
  totalVisits: number;
  totalEvidence: number;
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
  organization_id: string;
  template_code: string;
  template_name?: string | null;
  report_kind: 'monthly' | 'custom';
  report_scope: Record<string, unknown>;
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
  pdf_renderer_version: string | null;
  pdf_source_updated_at: string | null;
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

function reportKindLabel(pack: MonthlyReportPack): string {
  return pack.report_kind === 'custom' ? 'Custom' : 'Monthly';
}

function hasCurrentPdf(pack: MonthlyReportPack): boolean {
  return Boolean(pack.pdf_path && pack.pdf_source_updated_at && pack.pdf_source_updated_at === pack.updated_at);
}

function hasLatestReportPdf(pack: MonthlyReportPack): boolean {
  return hasCurrentPdf(pack) && pack.pdf_renderer_version === CURRENT_REPORT_PDF_RENDERER;
}

function reportPdfFilename(pack: MonthlyReportPack): string {
  const stem = `${reportAgreementName(pack)} ${pack.template_code} ${pack.period_start} to ${pack.period_end}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 150);
  return `${stem || 'FCM report'}.pdf`;
}

interface ReportPackRowProps {
  pack: MonthlyReportPack;
  busy: boolean;
  busyStage: string | null;
  onReview: () => void;
  onOpenPdf: () => void;
  onDownloadPdf: () => void;
  onGeneratePdf: () => void;
  onSend: () => void;
}

function reportPdfAction(pack: MonthlyReportPack, busy: boolean, busyStage: string | null, onOpenPdf: () => void, onDownloadPdf: () => void, onGeneratePdf: () => void): React.ReactNode {
  if (pack.status === 'sent' && hasCurrentPdf(pack)) {
    return <><button type="button" className="btn btn-sm btn-secondary" onClick={onOpenPdf} disabled={busy}>{busy ? 'Opening...' : 'Open PDF'}</button> <button type="button" className="btn btn-sm btn-secondary" onClick={onDownloadPdf} disabled={busy} aria-label="Download sent report PDF" title="Download PDF"><Download size={16} aria-hidden="true" /></button></>;
  }
  if (hasLatestReportPdf(pack)) {
    return <><button type="button" className="btn btn-sm btn-secondary" onClick={onOpenPdf} disabled={busy}>{busy ? 'Opening...' : 'Preview PDF'}</button> <button type="button" className="btn btn-sm btn-secondary" onClick={onDownloadPdf} disabled={busy} aria-label="Download report PDF" title="Download PDF"><Download size={16} aria-hidden="true" /></button></>;
  }
  if (pack.status === 'sent') return '-';
  return <button type="button" className="btn btn-sm btn-secondary" onClick={onGeneratePdf} disabled={busy} aria-live="polite">{busy ? (busyStage ?? 'Rendering...') : 'Generate preview'}</button>;
}

function reportDeliveryAction(pack: MonthlyReportPack, busy: boolean, onSend: () => void): React.ReactNode {
  if (pack.status === 'sent') {
    return pack.sent_at ? `Sent ${new Date(pack.sent_at).toLocaleString()}` : 'Sent';
  }
  const isPublished = pack.status === 'generated' && Boolean(pack.published_at);
  if (isPublished && pack.delivery_channel === 'portal') return 'Available in client portal';
  if (isPublished && pack.delivery_channel === 'email') {
    if (!hasLatestReportPdf(pack)) return 'Generate current reviewed PDF first';
    return <button type="button" className="btn btn-sm btn-primary" onClick={onSend} disabled={busy}>{busy ? 'Sending...' : 'Send reviewed report'}</button>;
  }
  return 'Publish after review';
}

function reportReviewAction(pack: MonthlyReportPack, onReview: () => void): React.ReactNode {
  if (pack.status === 'sent') return 'Issued record';
  return <button type="button" className="btn btn-sm btn-secondary" onClick={onReview}>{pack.reviewed_at ? 'Edit review' : 'Review'}</button>;
}

function ReportPackRow({ pack, busy, busyStage, onReview, onOpenPdf, onDownloadPdf, onGeneratePdf, onSend }: ReportPackRowProps) {
  return (
    <tr>
      <td>{reportAgreementName(pack)}</td>
      <td>{pack.period_start} to {pack.period_end}</td>
      <td>{reportKindLabel(pack)}</td>
      <td><span className={`status-badge status-${pack.status}`}>{reportStatusLabel(pack)}</span></td>
      <td>{reportReviewAction(pack, onReview)}</td>
      <td>{reportPdfAction(pack, busy, busyStage, onOpenPdf, onDownloadPdf, onGeneratePdf)}</td>
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
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const { isModuleEnabled } = useEnabledModules(organizationId);
  const freedomCampingEnabled = isModuleEnabled('freedom_camping');
  const relationships = useServiceRelationships();
  // The hub filters by an agreement the reader chooses here, not by the app-wide place context.
  const [agreementFilterId, setAgreementFilterId] = useState('');
  const [view, setView] = useState<'reports' | 'repeat'>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'repeat' ? 'repeat' : 'reports');
  const providerAgreements = useMemo(() => relationships.agreements.filter((agreement) => agreement.agreement_type === 'operational' && agreement.client_organization_id !== organizationId), [organizationId, relationships.agreements]);
  const selectedAgreement = useMemo(() => providerAgreements.find((agreement) => agreement.id === agreementFilterId) ?? null, [agreementFilterId, providerAgreements]);
  const [metrics, setMetrics] = useState<ReportMetrics>({
    totalBreaches: 0,
    totalObservations: 0,
    nonCompliantObservations: 0,
    totalVisits: 0,
    totalEvidence: 0,
  });

  const [reportScope, setReportScope] = useState<{ zoneIds: string[]; siteIds: string[] }>({ zoneIds: [], siteIds: [] });
  const [reportPacks, setReportPacks] = useState<MonthlyReportPack[]>([]);
  const [consolidatedReporting, setConsolidatedReporting] = useState<ConsolidatedReportingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generatingRollup, setGeneratingRollup] = useState(false);
  const [showCustomReportBuilder, setShowCustomReportBuilder] = useState(false);
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [busyStage, setBusyStage] = useState<string | null>(null);
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
    if (!organizationId) {
      setError('Organisation access could not be confirmed. Reports are unavailable.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const reportAgreementIds = selectedAgreement ? [selectedAgreement.id] : providerAgreements.map((agreement) => agreement.id);
      let activeZoneIds: string[] | null = null;
      let reportZoneIds: string[] = [];
      let reportSiteIds: string[] = [];
      if (reportAgreementIds.length > 0) {
        const { data: links, error: linksError } = await supabase
          .from('service_agreement_locations')
          .select('zone_id,site_id')
          .in('service_agreement_id', reportAgreementIds)
          .eq('status', 'active');
        if (linksError) throw linksError;
        reportZoneIds = [...new Set((links ?? []).map((link) => link.zone_id).filter((id): id is string => Boolean(id)))];
        reportSiteIds = [...new Set((links ?? []).map((link) => link.site_id).filter((id): id is string => Boolean(id)))];
        activeZoneIds = reportZoneIds.length > 0 ? reportZoneIds : null;
      }
      setReportScope((current) => (current.zoneIds.join(',') === reportZoneIds.join(',') && current.siteIds.join(',') === reportSiteIds.join(',') ? current : { zoneIds: reportZoneIds, siteIds: reportSiteIds }));
      const timestampEndExclusive = exclusiveEndIso(dateRange.end);
      // Report packs belong to the agreement's provider, which is a branch under the Model A house; list the whole house.
  const { data: descendantOrgIds } = await supabase.rpc('get_descendant_organizations', { org_id: organizationId });
  const houseOrgIds = [...new Set([organizationId, ...(Array.isArray(descendantOrgIds) ? descendantOrgIds : [])])];
      const clientOrganizationIds = [...new Set(
        (selectedAgreement ? [selectedAgreement] : providerAgreements)
          .map((agreement) => agreement.client_organization_id)
          .filter((id): id is string => Boolean(id)),
      )];
      const placeFilter = [
        ...(reportZoneIds.length > 0 ? [`zone_id.in.(${reportZoneIds.join(',')})`] : []),
        ...(reportSiteIds.length > 0 ? [`client_site_id.in.(${reportSiteIds.join(',')})`] : []),
      ].join(',');
      const observationPlaceFilter = [
        ...(reportZoneIds.length > 0 ? [`zone_id.in.(${reportZoneIds.join(',')})`] : []),
        ...(reportSiteIds.length > 0 ? [`site_id.in.(${reportSiteIds.join(',')})`] : []),
      ].join(',');
      const [breachResponse, observationResponse, visitResponse, evidenceResponse, packResponse, consolidatedResponse] = await Promise.all([
        !freedomCampingEnabled
          ? Promise.resolve({ data: [], error: null })
          : activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .in('zone_id', activeZoneIds)
              .gte('created_at', dateRange.start)
              .lt('created_at', timestampEndExclusive)
              .order('created_at', { ascending: false })
              : selectedAgreement
              ? Promise.resolve({ data: [], error: null })
          : supabase
              .from('breach_alerts')
              .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
              .eq('organization_id', organizationId)
              .gte('created_at', dateRange.start)
              .lt('created_at', timestampEndExclusive)
              .order('created_at', { ascending: false }),
        observationPlaceFilter
          ? supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, subject_kind, is_compliant, compliance_reason, zone_id')
              .or(observationPlaceFilter)
              .gte('observed_at', dateRange.start)
              .lt('observed_at', timestampEndExclusive)
              .order('observed_at', { ascending: false })
              : selectedAgreement
              ? Promise.resolve({ data: [], error: null })
          : supabase
              .from('observations')
              .select('id, observed_at, plate_number, officer_id, subject_kind, is_compliant, compliance_reason, zone_id')
              .eq('organization_id', organizationId)
              .gte('observed_at', dateRange.start)
              .lt('observed_at', timestampEndExclusive)
              .order('observed_at', { ascending: false }),
        placeFilter
          ? supabase
              .from('location_events')
              .select('id', { count: 'exact', head: true })
              .or(placeFilter)
              .gte('occurred_at', dateRange.start)
              .lt('occurred_at', timestampEndExclusive)
          : Promise.resolve({ count: 0, error: null }),
        clientOrganizationIds.length > 0
          ? supabase
              .from('evidence_items')
              .select('id', { count: 'exact', head: true })
              .in('organization_id', clientOrganizationIds)
              .gte('captured_at', dateRange.start)
              .lt('captured_at', timestampEndExclusive)
          : Promise.resolve({ count: 0, error: null }),
        selectedAgreement?.id
          ? supabase
              .from('monthly_report_packs')
              .select('id, organization_id, template_code, report_kind, report_scope, period_start, period_end, status, data, editorial, generated_at, updated_at, reviewed_at, published_at, delivery_channel, sent_at, pdf_path, pdf_sha256, pdf_renderer_version, pdf_source_updated_at, agreement:service_agreement_id(name)')
              .eq('service_agreement_id', selectedAgreement.id)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false })
          : supabase
              .from('monthly_report_packs')
              .select('id, organization_id, template_code, report_kind, report_scope, period_start, period_end, status, data, editorial, generated_at, updated_at, reviewed_at, published_at, delivery_channel, sent_at, pdf_path, pdf_sha256, pdf_renderer_version, pdf_source_updated_at, agreement:service_agreement_id(name)')
              .in('organization_id', houseOrgIds)
              .gte('period_start', dateRange.start)
              .lte('period_end', dateRange.end)
              .order('period_end', { ascending: false }),
        // The overview is per branch of the house; there is no per-agreement overload (calling one 404'd and failed the whole page).
        supabase.rpc('get_consolidated_reporting_overview', { p_root_organization_id: organizationId, p_from: dateRange.start, p_to: dateRange.end }),
      ]);

      const failure = breachResponse.error ?? observationResponse.error ?? visitResponse.error ?? evidenceResponse.error ?? packResponse.error ?? consolidatedResponse.error;
      if (failure) throw failure;
      const breaches = (breachResponse.data as BreachAlert[]) || [];
      const obs = (observationResponse.data as Observation[]) || [];
      const packs = (packResponse.data as MonthlyReportPack[]) || [];
      const templateCodes = [...new Set(packs.map((pack) => pack.template_code).filter(Boolean))];
      const templateNames = new Map<string, string>();
      if (templateCodes.length) {
        const { data: templates } = await supabase.from('report_templates').select('organization_id,template_code,name')
          .in('organization_id', houseOrgIds).in('template_code', templateCodes);
        for (const template of templates ?? []) templateNames.set(`${template.organization_id}:${template.template_code}`, template.name);
      }
      setReportPacks(packs.map((pack) => ({ ...pack, template_name: templateNames.get(`${pack.organization_id}:${pack.template_code}`) ?? null })));
      setConsolidatedReporting((consolidatedResponse.data as ConsolidatedReportingRow[]) || []);
      setMetrics({
        totalBreaches: breaches.length,
        totalObservations: obs.length,
        nonCompliantObservations: obs.filter((o) => o.is_compliant === false).length,
        totalVisits: visitResponse.count ?? 0,
        totalEvidence: evidenceResponse.count ?? 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [freedomCampingEnabled, organizationId, selectedAgreement, providerAgreements, dateRange.end, dateRange.start]);

  useEffect(() => { void loadReports(); }, [loadReports]);

  const generateReportPacks = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    const { data, error: generationError } = await supabase.rpc('generate_due_report_packs', {
      p_period_start: dateRange.start,
      p_period_end: dateRange.end,
      p_service_agreement_id: selectedAgreement?.id ?? null,
    });
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
    const bobNotes: string[] = [];
    let privacyCleared = false;
    let withheld = 0;
    if (pack.report_kind !== 'custom' && pack.status !== 'sent') {
      // Names are withheld before Bob reads the entries, so his summary never sees them.
      setBusyStage('Bob is checking for personal names...');
      const privacy = await runPrivacyCheck(pack.id);
      if (privacy.error) bobNotes.push(`Bob could not finish the privacy check (${privacy.error}); try again before Bob reviews the entries.`);
      else if (!privacy.cleared) bobNotes.push(`Bob still has ${privacy.remaining === 1 ? '1 entry' : `${privacy.remaining} entries`} to check for personal names; generate the preview again to continue.`);
      privacyCleared = privacy.cleared;
      withheld = privacy.reworded;
    }
    if (privacyCleared) {
      // Bob reads the entries only once every name in them has been withheld.
      setBusyStage('Bob is reviewing...');
      const scan = await runIncidentScan(pack.id);
      if (scan.error) bobNotes.push(`Bob could not finish checking for potential incidents (${scan.error}); use Ask Bob in the review to continue.`);
      else if (scan.flagged > 0) bobNotes.push(`Bob highlighted ${scan.flagged === 1 ? '1 possible incident' : `${scan.flagged} possible incidents`} for your review.`);
      else if (scan.remaining > 0) bobNotes.push('Bob has more entries to check; use Ask Bob in the review to continue.');
      if (pack.status === 'draft') {
        setBusyStage('Bob is drafting the summary...');
        const draft = await draftSummaryIfEmpty(pack.id);
        if (draft.error) bobNotes.push(`Bob could not draft the executive summary (${draft.error}).`);
        else if (draft.saved) bobNotes.push('Bob drafted the executive summary; check and edit it in the review before publishing.');
      }
      setBusyStage('Bob is checking for personal names...');
      const recheck = await runPrivacyCheck(pack.id);
      if (recheck.error) bobNotes.push(`Bob could not finish the privacy check (${recheck.error}).`);
      else if (!recheck.cleared) bobNotes.push(`Bob still has ${recheck.remaining === 1 ? '1 entry' : `${recheck.remaining} entries`} to check for personal names; generate the preview again to continue.`);
      withheld += recheck.reworded;
    }
    if (withheld > 0) bobNotes.push(`Bob withheld personal names or contact details in ${withheld === 1 ? '1 place' : `${withheld} places`}.`);
    setBusyStage('Rendering...');
    const { error: renderError } = await supabase.functions.invoke('generate-report-pack-pdf', { body: { pack_id: pack.id } });
    if (renderError) setError([await functionErrorMessage(renderError, 'The PDF preview could not be generated.'), ...bobNotes].join(' '));
    else { setNotice([`PDF preview for ${pack.period_start} to ${pack.period_end} is ready to review.`, ...bobNotes].join(' ')); await loadReports(); }
    setBusyStage(null);
    setBusyPackId(null);
  };

  const openReportPackPdf = async (pack: MonthlyReportPack) => {
    if (!hasCurrentPdf(pack) || !pack.pdf_path) return;
    setBusyPackId(pack.id);
    setError(null);
    const { data, error: signedError } = await supabase.storage.from('bob-uploads').createSignedUrl(pack.pdf_path, 900);
    if (signedError || !data?.signedUrl) setError(signedError?.message ?? 'The PDF preview could not be opened.');
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    setBusyPackId(null);
  };

  const downloadReportPackPdf = async (pack: MonthlyReportPack) => {
    if (!hasCurrentPdf(pack) || !pack.pdf_path) return;
    setBusyPackId(pack.id);
    setError(null);
    setNotice(null);
    const { data, error: downloadError } = await supabase.storage.from('bob-uploads').download(pack.pdf_path);
    if (downloadError || !data) {
      setError(downloadError?.message ?? 'The PDF could not be downloaded.');
    } else {
      const objectUrl = URL.createObjectURL(data);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = reportPdfFilename(pack);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(`Downloading ${anchor.download}.`);
    }
    setBusyPackId(null);
  };

  const finishReview = async (message: string) => {
    setNotice(message);
    setError(null);
    setReviewingPackId(null);
    await loadReports();
  };

  const finishCustomReport = async (message: string, agreementId: string) => {
    setNotice(message);
    setError(null);
    setAgreementFilterId(agreementId);
    setShowCustomReportBuilder(false);
    if (agreementId === agreementFilterId) await loadReports();
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

  return (
    <div className="page-container reports-hub-page">
      <header className="page-header">
        <h1>Reports</h1>
        <p className="subtitle">Create, review and deliver accountable client reports.</p>
      </header>

      {loading && <p className="subtitle" role="status">Refreshing report totals…</p>}
      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {notice && <output className="alert alert-success">{notice}</output>}

      <div className="reports-tabs" role="tablist" aria-label="Reports and accountability views">
        <button type="button" role="tab" id="reports-tab-reports" aria-controls="reports-panel-reports" aria-selected={view === 'reports'}
          className={`reports-tab${view === 'reports' ? ' is-active' : ''}`} onClick={() => setView('reports')}>Records &amp; client reports</button>
        <button type="button" role="tab" id="reports-tab-repeat" aria-controls="reports-panel-repeat" aria-selected={view === 'repeat'}
          className={`reports-tab${view === 'repeat' ? ' is-active' : ''}`} onClick={() => setView('repeat')}>Repeat subject review</button>
      </div>

      {view === 'repeat' && <section id="reports-panel-repeat" role="tabpanel" aria-labelledby="reports-tab-repeat" className="reports-section reports-subject-review">
        <p className="subtitle">Trends across every authorised agreement and observation: vehicles and people that keep returning, including to places managed by different teams.</p>
        <RepeatSubjectsPanel />
      </section>}

      {view === 'reports' && <div id="reports-panel-reports" role="tabpanel" aria-labelledby="reports-tab-reports">
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
            aria-label="Report period start"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            max={dateRange.end}
          />
          <span>to</span>
          <input
            type="date"
            aria-label="Report period end"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            min={dateRange.start}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void generateReportPacks()} disabled={generating}>{generating ? 'Generating...' : 'Generate report drafts'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setShowCustomReportBuilder((current) => !current)} disabled={providerAgreements.length === 0} aria-expanded={showCustomReportBuilder}>
          <FilePlus2 size={17} aria-hidden="true" /> Build custom report
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void generateDailyRollup()} disabled={generatingRollup}>{generatingRollup ? 'Generating rollup...' : 'Generate daily rollup'}</button>
      </div>

      {showCustomReportBuilder && (
        <CustomReportBuilder
          agreements={providerAgreements}
          initialAgreementId={selectedAgreement?.id ?? null}
          periodStart={dateRange.start}
          periodEnd={dateRange.end}
          onClose={() => setShowCustomReportBuilder(false)}
          onCreated={finishCustomReport}
        />
      )}

      <section className="reports-workflow-intro" aria-labelledby="reports-records-heading">
        <div>
          <span>Step 1 · Review source records</span>
          <h2 id="reports-records-heading">Records and evidence</h2>
          <p>Check the underlying patrol activity, observations, notes, provenance, and photos before producing a client report.</p>
        </div>
        <strong>{selectedAgreement ? selectedAgreement.name : `${providerAgreements.length} agreements`}</strong>
      </section>

      <div className="kpi-grid reports-kpi-grid" aria-label="Current reporting scope totals">
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalVisits}</div>
          <div className="kpi-label">Patrol activity</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalObservations}</div>
          <div className="kpi-label">Observations</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalEvidence}</div>
          <div className="kpi-label">Evidence items</div>
          <div className="kpi-unit">captured this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{reportPacks.length}</div>
          <div className="kpi-label">Report packs</div>
          <div className="kpi-unit">in this period</div>
        </div>
        {freedomCampingEnabled && <div className="kpi-card">
          <div className="kpi-value">{metrics.totalBreaches}</div>
          <div className="kpi-label">Breach alerts</div>
          <div className="kpi-unit">{metrics.nonCompliantObservations} non-compliant observations</div>
        </div>}
      </div>

      <ActivityRecordBrowser zoneIds={reportScope.zoneIds} siteIds={reportScope.siteIds} scopeLabel={selectedAgreement ? selectedAgreement.name : 'all your agreements'} />

      <section className="reports-section report-packs-section" aria-labelledby="report-production-heading">
        <div className="reports-production-heading">
          <div>
            <span>Step 2 · Produce and approve</span>
            <h2 id="report-production-heading">Client report production ({reportPacks.length})</h2>
          </div>
          <p>Draft → human review → governed PDF → approved delivery</p>
        </div>
        <p className="subtitle">Generated evidence remains provider-private until an administrator reviews and publishes it. The source records above remain the accountability anchor.</p>
        <p className="report-packs-scroll-cue">Scroll horizontally to review report status, PDF, and delivery actions.</p>
        <div className="reports-table-wrapper report-packs-table-region" role="region" aria-label="Report packs" tabIndex={0}>
          <table className="reports-table">
            <thead><tr><th>Agreement</th><th>Period</th><th>Type</th><th>Status</th><th>Review</th><th>PDF</th><th>Delivery</th></tr></thead>
            <tbody>
              {reportPacks.length === 0 ? <tr><td colSpan={7} className="text-center">No report packs in this period. Check the scope and source records above, then generate report drafts.</td></tr> : reportPacks.map((pack) => (
                <ReportPackRow
                  key={pack.id}
                  pack={pack}
                  busy={busyPackId === pack.id}
                  busyStage={busyPackId === pack.id ? busyStage : null}
                  onReview={() => setReviewingPackId(pack.id)}
                  onOpenPdf={() => void openReportPackPdf(pack)}
                  onDownloadPdf={() => void downloadReportPackPdf(pack)}
                  onGeneratePdf={() => void generateReportPackPdf(pack)}
                  onSend={() => void sendReportPack(pack)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {reviewingPack && <ReportPackReviewPanel pack={{ ...reviewingPack, agreementName: reportAgreementName(reviewingPack), templateName: reviewingPack.template_name ?? null } as ReviewableReportPack} onClose={() => setReviewingPackId(null)} onSaved={finishReview} />}
      </section>

      {consolidatedReporting.length > 1 && <details className="reports-section reports-oversight">
        <summary className="reports-oversight__summary">
          <h2>Group Reporting Overview</h2>
          <span>{consolidatedReporting.length} operating organisations</span>
        </summary>
        <p className="subtitle">Branch-owned operational activity, consolidated for parent oversight. Record detail remains in the selected agreement and place context.</p>
        <div className="reports-table-wrapper" role="region" aria-label="Group reporting overview" tabIndex={0}>
          <table className="reports-table"><thead><tr><th>Operating Organization</th><th>Breach Alerts</th><th>Observations</th><th>Non-Compliant</th><th>Report Packs</th></tr></thead><tbody>{consolidatedReporting.map((row) => <tr key={row.source_organization_id}><td>{row.source_organization_name}</td><td>{row.breach_count}</td><td>{row.observation_count}</td><td>{row.non_compliant_observation_count}</td><td>{row.report_pack_count}</td></tr>)}</tbody></table>
        </div>
      </details>}
      </div>}
    </div>
  );
};

export default ReportsHubPage;
