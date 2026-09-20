import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Eye,
  FileText,
  MapPin,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Siren,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ClientPeoplePanel } from '../components/ClientPeoplePanel';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import type { ClientPortalPage } from '../lib/clientPortalAccess';
import { getClientPortalPages } from '../lib/clientPortalAccess';
import { formatComplianceReason } from '../lib/freedomCampingStatus';
import { asDeliverySummary, deliveryPeriodBounds, deliveryWords, hoursOnPost, responseWords, type DeliveryPeriod, type DeliverySummary } from '../lib/serviceDelivery';
import { supabase } from '../lib/supabase';
import './ClientPortalPage.css';

interface ClientObservation {
  id: string;
  plate_number: string;
  module_key: string;
  compliance_status: 'compliant' | 'at_risk' | 'breach' | 'breach_exempt' | 'unknown' | null;
  compliance_reason: string | null;
  observed_at: string;
  site_id: string | null;
  zone_id: string | null;
}

interface MonthlyReportPack {
  id: string;
  template_code: string;
  period_start: string;
  period_end: string;
  status: 'draft' | 'generated' | 'sent' | 'failed';
  generated_at: string | null;
  sent_at: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  delivery_error: string | null;
}

interface ClientInvoice {
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number | null;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
}

export function ClientPortalPage({ page }: { page: ClientPortalPage }) {
  const { profile } = useAuth();
  const relationships = useServiceRelationships();
  const [observations, setObservations] = useState<ClientObservation[]>([]);
  const [reports, setReports] = useState<MonthlyReportPack[]>([]);
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [deliveryPeriod, setDeliveryPeriod] = useState<DeliveryPeriod>('this_month');
  const [delivery, setDelivery] = useState<DeliverySummary | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const agreement = relationships.selectedAgreement;
  const allowedPages = useMemo(() => getClientPortalPages(agreement ? {
    mode: agreement.client_portal_access_mode as 'transparency_only' | 'full_modules' | 'scan_only' | null,
    reportsEnabled: agreement.client_portal_reports_enabled,
    financeEnabled: agreement.client_portal_finance_enabled,
  } : null, profile?.role), [agreement, profile?.role]);

  const loadRecords = useCallback(async () => {
    if (!profile?.organizationId || !agreement) {
      setObservations([]);
      setReports([]);
      setInvoices([]);
      setLoadingRecords(false);
      return;
    }

    setLoadingRecords(true);
    setRecordsError(null);
    try {
      const observationPromise = allowedPages.has('observations')
        ? (() => {
            const siteIds = relationships.selectedAgreementSites.map((site) => site.id);
            const zoneIds = relationships.selectedAgreementZones.map((zone) => zone.id);
            const locationFilters = [
              siteIds.length ? `site_id.in.(${siteIds.join(',')})` : null,
              zoneIds.length ? `zone_id.in.(${zoneIds.join(',')})` : null,
            ].filter(Boolean).join(',');

            if (!locationFilters) return Promise.resolve({ data: [], error: null });
            return supabase
              .from('observations')
              .select('id, plate_number, module_key, compliance_status, compliance_reason, observed_at, site_id, zone_id')
              .eq('client_org_id', profile.organizationId)
              .or(locationFilters)
              .order('observed_at', { ascending: false })
              .limit(100);
          })()
        : Promise.resolve({ data: [], error: null });

      const reportPromise = allowedPages.has('reports')
        ? supabase
            .from('monthly_report_packs')
            .select('id, template_code, period_start, period_end, status, generated_at, sent_at, pdf_path, pdf_sha256, delivery_error')
            .eq('service_agreement_id', agreement.id)
            .order('period_end', { ascending: false })
            .limit(24)
        : Promise.resolve({ data: [], error: null });

      const invoicePromise = allowedPages.has('finance')
        ? supabase
            .from('invoices')
            .select('id, invoice_number, status, total_amount, currency, invoice_date, due_date, sent_at, paid_at')
            .eq('service_agreement_id', agreement.id)
            .order('invoice_date', { ascending: false })
            .limit(24)
        : Promise.resolve({ data: [], error: null });

      const [observationResponse, reportResponse, invoiceResponse] = await Promise.all([observationPromise, reportPromise, invoicePromise]);
      if (observationResponse.error) throw observationResponse.error;
      if (reportResponse.error) throw reportResponse.error;
      if (invoiceResponse.error) throw invoiceResponse.error;
      setObservations((observationResponse.data as ClientObservation[]) ?? []);
      setReports((reportResponse.data as MonthlyReportPack[]) ?? []);
      setInvoices((invoiceResponse.data as ClientInvoice[]) ?? []);
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : 'Client records could not be loaded.');
      setObservations([]);
      setReports([]);
      setInvoices([]);
    } finally {
      setLoadingRecords(false);
    }
  }, [agreement, allowedPages, profile?.organizationId, relationships.selectedAgreementSites, relationships.selectedAgreementZones]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  // ATLAS READS: get_agreement_service_delivery — scoped server-side to this agreement's places; no officer identities
  useEffect(() => {
    if (!agreement || !allowedPages.has('delivery')) { setDelivery(null); return; }
    let cancelled = false;
    const bounds = deliveryPeriodBounds(deliveryPeriod);
    setDeliveryLoading(true); setDeliveryError(null);
    supabase.rpc('get_agreement_service_delivery', { p_agreement_id: agreement.id, p_period_start: bounds.start, p_period_end: bounds.end }).then(({ data, error }) => {
      if (cancelled) return;
      const parsed = asDeliverySummary(data);
      if (error || !parsed) { setDeliveryError(error?.message ?? 'Delivered work could not be loaded.'); setDelivery(null); }
      else setDelivery(parsed);
      setDeliveryLoading(false);
    });
    return () => { cancelled = true; };
  }, [agreement, allowedPages, deliveryPeriod]);

  if (relationships.loading) {
    return <div className="client-page-state"><RefreshCw className="is-spinning" size={22} aria-hidden="true" /> Loading service access</div>;
  }

  if (relationships.error) {
    return (
      <div className="client-page-state is-error" role="alert">
        <AlertTriangle size={23} aria-hidden="true" />
        <strong>Service access could not be verified</strong>
        <span>{relationships.error}</span>
        <button type="button" onClick={() => void relationships.refetch()}>Try again</button>
      </div>
    );
  }

  if (!agreement) {
    return (
      <div className="client-page-state">
        <ShieldCheck size={24} aria-hidden="true" />
        <strong>No active service relationship</strong>
        <span>Your organisation is signed in, but no service agreement is available for this portal.</span>
      </div>
    );
  }

  if (!allowedPages.has(page)) {
    return (
      <div className="client-page-state">
        <ShieldCheck size={24} aria-hidden="true" />
        <strong>This view is not included in the selected agreement</strong>
        <span>Portal access is controlled by the service agreement, not by the menu or URL.</span>
      </div>
    );
  }

  const providerName = agreement.provider_name ?? 'Service provider';
  const statusCounts = observations.reduce<Record<string, number>>((counts, observation) => {
    const status = observation.compliance_status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <div className="client-portal-page">
      <header className="client-page-heading">
        <div>
          <span className="client-kicker">{providerName}</span>
          <h1>{pageTitle(page)}</h1>
          <p>{pageDescription(page)}</p>
        </div>
        <div className="client-heading-actions">
          {relationships.agreements.length > 1 && (
            <label>
              <span className="sr-only">Service agreement</span>
              <select value={agreement.id} onChange={(event) => relationships.selectAgreement(event.target.value)}>
                {relationships.agreements.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" onClick={() => void loadRecords()} disabled={loadingRecords} title="Refresh client records">
            <RefreshCw size={17} className={loadingRecords ? 'is-spinning' : ''} aria-hidden="true" />
            <span className="sr-only">Refresh client records</span>
          </button>
        </div>
      </header>

      {recordsError && <div className="client-inline-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /> {recordsError}</div>}

      {page === 'overview' && (
        <>
          <section className="client-agreement-band">
            <div><span>Service agreement</span><strong>{agreement.name}</strong></div>
            <div><span>Portal access</span><strong>{agreement.client_portal_access_mode?.replace(/_/g, ' ') ?? 'Not configured'}</strong></div>
            <div><span>Locations</span><strong>{relationships.selectedAgreementSites.length + relationships.selectedAgreementZones.length}</strong></div>
            <div><span>Reports</span><strong>{agreement.client_portal_reports_enabled ? 'Enabled' : 'Not enabled'}</strong></div>
          </section>

          <div className="client-overview-grid">
            {allowedPages.has('delivery') && (
              <section className="client-overview-panel">
                <div className="client-panel-heading"><div><span className="client-kicker">Delivered this month</span><h2>Presence at your places</h2></div><ShieldCheck size={21} aria-hidden="true" /></div>
                {deliveryLoading || !delivery ? (
                  <div className="client-compact-state">{deliveryError ?? 'Checking delivered work'}</div>
                ) : (
                  <div className="client-status-summary">
                    <StatusCount label="Visits done" value={delivery.totals.patrol_completed} tone="success" />
                    <StatusCount label="Visits missed" value={delivery.totals.patrol_missed} tone={delivery.totals.patrol_missed ? 'danger' : 'neutral'} />
                    <StatusCount label="Guard attendances" value={delivery.totals.post_attended} tone="success" />
                    <div className="client-status-count tone-neutral"><strong>{hoursOnPost(delivery.totals.post_minutes)}</strong><span>On post</span></div>
                  </div>
                )}
              </section>
            )}
            <section className="client-overview-panel">
              <div className="client-panel-heading"><div><span className="client-kicker">Activity</span><h2>Recent field evidence</h2></div><Eye size={21} aria-hidden="true" /></div>
              {!allowedPages.has('observations') ? (
                <p className="client-panel-note">Observation-level access is not included in this agreement. Generated reports remain available when enabled.</p>
              ) : loadingRecords ? (
                <div className="client-compact-state">Loading observations</div>
              ) : observations.length === 0 ? (
                <div className="client-compact-state">No observations are linked to this agreement yet.</div>
              ) : (
                <div className="client-status-summary">
                  <StatusCount label="Compliant" value={statusCounts.compliant ?? 0} tone="success" />
                  <StatusCount label="At risk" value={statusCounts.at_risk ?? 0} tone="warning" />
                  <StatusCount label="Breaches" value={statusCounts.breach ?? 0} tone="danger" />
                  <StatusCount label="Review" value={statusCounts.unknown ?? 0} tone="neutral" />
                </div>
              )}
            </section>

            <section className="client-overview-panel">
              <div className="client-panel-heading"><div><span className="client-kicker">Reporting</span><h2>Latest report pack</h2></div><FileText size={21} aria-hidden="true" /></div>
              {!agreement.client_portal_reports_enabled ? (
                <p className="client-panel-note">Monthly report packs are not enabled for this agreement.</p>
              ) : loadingRecords ? (
                <div className="client-compact-state">Loading reports</div>
              ) : reports.length === 0 ? (
                <div className="client-compact-state">No report pack has been generated yet.</div>
              ) : (
                <ReportRow report={reports[0]} />
              )}
            </section>
          </div>

          <section className="client-location-preview">
            <div className="client-panel-heading"><div><span className="client-kicker">Service footprint</span><h2>Covered locations</h2></div><Building2 size={21} aria-hidden="true" /></div>
            <LocationGrid sites={relationships.selectedAgreementSites.slice(0, 4)} zones={relationships.selectedAgreementZones.slice(0, 4)} />
          </section>
        </>
      )}

      {page === 'delivery' && (
        <section className="client-list-section client-delivery">
          <div className="client-delivery-toolbar" role="group" aria-label="Period">
            <button type="button" className={deliveryPeriod === 'this_month' ? 'is-active' : ''} onClick={() => setDeliveryPeriod('this_month')}>This month so far</button>
            <button type="button" className={deliveryPeriod === 'last_month' ? 'is-active' : ''} onClick={() => setDeliveryPeriod('last_month')}>Last month</button>
          </div>
          {deliveryError && <div className="client-inline-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /> {deliveryError}</div>}
          {deliveryLoading || !delivery ? <div className="client-compact-state">Checking delivered work</div> : (
            <>
              <p className="client-delivery-note">Counted from the shifts {providerName} started and ended in the app, and the arrivals and departures recorded at each place. Only shifts already due are counted; the names of individual officers are not shown here.</p>
              <div className="client-status-summary">
                <StatusCount label="Visits done" value={delivery.totals.patrol_completed} tone="success" />
                <StatusCount label="Visits missed" value={delivery.totals.patrol_missed} tone={delivery.totals.patrol_missed ? 'danger' : 'neutral'} />
                <StatusCount label="Visits late" value={delivery.totals.patrol_late} tone={delivery.totals.patrol_late ? 'warning' : 'neutral'} />
                <StatusCount label="Guard attendances" value={delivery.totals.post_attended} tone="success" />
                <div className="client-status-count tone-neutral"><strong>{hoursOnPost(delivery.totals.post_minutes)}</strong><span>On post</span></div>
              </div>
              {(() => { const response = responseWords(delivery); return response && <p className={`client-delivery-note client-delivery-responses is-${response.tone}`}><Siren size={15} aria-hidden="true" /><span><b>Alarms and incidents</b> {response.text}</span></p>; })()}
              {delivery.places.length === 0 ? <div className="client-compact-state">No places are linked to this agreement yet.</div> : (
                <div className="client-delivery-list">
                  {delivery.places.map((place) => { const words = deliveryWords(place); return (
                    <article key={place.location_id} className={place.patrol_missed ? 'has-missed' : ''}>
                      <span>{place.place_kind === 'zone' ? <MapPin size={18} /> : <Building2 size={18} />}</span>
                      <div>
                        <strong>{place.place_name ?? 'Contracted place'}</strong>
                        {words.patrol && <small>{words.patrol}</small>}
                        {words.post && <small>{words.post}</small>}
                        {!words.patrol && !words.post && <small>Nothing was due here in this period.</small>}
                      </div>
                      <em>{words.presence}</em>
                    </article>
                  ); })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {page === 'sites' && (
        <section className="client-list-section">
          <LocationGrid sites={relationships.selectedAgreementSites} zones={relationships.selectedAgreementZones} />
        </section>
      )}

      {page === 'observations' && (
        <section className="client-list-section">
          {loadingRecords ? <div className="client-compact-state">Loading observations</div> : observations.length === 0 ? <div className="client-compact-state">No observations are linked to this agreement.</div> : (
            <div className="client-observation-list">
              {observations.map((observation) => (
                <article key={observation.id}>
                  <span className={`client-status-mark status-${observation.compliance_status ?? 'unknown'}`} />
                  <div><strong>{observation.plate_number}</strong><small>{observation.module_key.replace(/_/g, ' ')}</small></div>
                  <div><strong>{formatComplianceReason(observation.compliance_reason) || (observation.compliance_status ?? 'Review required').replace(/_/g, ' ')}</strong><small>{locationName(observation, relationships.selectedAgreementSites, relationships.selectedAgreementZones)}</small></div>
                  <time dateTime={observation.observed_at}>{new Date(observation.observed_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {page === 'reports' && (
        <section className="client-list-section">
          {loadingRecords ? <div className="client-compact-state">Loading report packs</div> : reports.length === 0 ? <div className="client-compact-state">No monthly report packs are available.</div> : (
            <div className="client-report-list">{reports.map((report) => <ReportRow report={report} key={report.id} />)}</div>
          )}
        </section>
      )}

      {page === 'finance' && (
        <section className="client-list-section">
          {loadingRecords ? <div className="client-compact-state">Loading invoices</div> : invoices.length === 0 ? <div className="client-compact-state">No invoices are available for this agreement.</div> : (
            <div className="client-report-list">{invoices.map((invoice) => <InvoiceRow invoice={invoice} key={invoice.id} />)}</div>
          )}
        </section>
      )}

      {page === 'people' && profile?.organizationId && profile.role === 'client_admin' && (
        <ClientPeoplePanel organizationId={profile.organizationId} currentUserId={profile.id} />
      )}

      {page === 'scan' && (
        <div className="client-page-state client-scan-state">
          <ScanLine size={28} aria-hidden="true" />
          <strong>Client scan access is not yet rebuilt</strong>
          <span>This agreement is configured for scan-only access. The scan interaction will remain unavailable until its edge-function contract is verified.</span>
        </div>
      )}
    </div>
  );
}

function pageTitle(page: ClientPortalPage): string {
  return { overview: 'Service overview', delivery: 'Service delivered', sites: 'Sites and zones', observations: 'Field observations', reports: 'Monthly reports', finance: 'Invoices', scan: 'Scan access', people: 'Your people' }[page];
}

function pageDescription(page: ClientPortalPage): string {
  return {
    overview: 'A clear view of contracted field work and delivered records.',
    delivery: 'What was actually delivered at your places: contracted visits made, guards on post and for how long.',
    sites: 'Locations included in the selected service agreement.',
    observations: 'Field evidence shared with your organisation.',
    reports: 'Generated reporting periods and delivery status.',
    finance: 'Invoices issued against this service agreement.',
    scan: 'Standalone scan access for this service agreement.',
    people: 'Add the people at your organisation who should be able to sign in, and remove access when they leave.',
  }[page];
}

function StatusCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`client-status-count tone-${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function LocationGrid({ sites, zones }: { sites: Array<{ id: string; name: string; address: string | null; site_type: string | null; active: boolean }>; zones: Array<{ id: string; name: string; zone_type: string | null; is_active: boolean }> }) {
  if (!sites.length && !zones.length) return <div className="client-compact-state">No locations are linked to this agreement.</div>;
  return (
    <div className="client-location-grid">
      {sites.map((site) => <article key={site.id}><span><Building2 size={18} /></span><div><strong>{site.name}</strong><small>{site.address ?? site.site_type?.replace(/_/g, ' ') ?? 'Site'}</small></div><em>{site.active ? 'Active' : 'Inactive'}</em></article>)}
      {zones.map((zone) => <article key={zone.id}><span><MapPin size={18} /></span><div><strong>{zone.name}</strong><small>{zone.zone_type?.replace(/_/g, ' ') ?? 'Service zone'}</small></div><em>{zone.is_active ? 'Active' : 'Inactive'}</em></article>)}
    </div>
  );
}

function ReportRow({ report }: { report: MonthlyReportPack }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPdf = async () => {
    if (!report.pdf_path) return;
    setOpening(true);
    setError(null);
    const { data, error: signedError } = await supabase.storage.from('bob-uploads').createSignedUrl(report.pdf_path, 900);
    if (signedError || !data?.signedUrl) setError(signedError?.message ?? 'The report PDF could not be opened.');
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    setOpening(false);
  };
  return (
    <article className="client-report-row">
      <span><CalendarRange size={19} /></span>
      <div><strong>{new Date(`${report.period_start}T00:00:00`).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' })}</strong><small>{report.template_code.replace(/_/g, ' ')}</small></div>
      <div><strong>{report.status}</strong><small>{report.sent_at ? `Sent ${new Date(report.sent_at).toLocaleDateString('en-NZ')}` : report.generated_at ? `Generated ${new Date(report.generated_at).toLocaleDateString('en-NZ')}` : 'Not generated'}</small></div>
      {report.pdf_path && <button type="button" onClick={() => void openPdf()} disabled={opening} title="Open report PDF"><FileText size={17} aria-hidden="true" /><span className="sr-only">{opening ? 'Opening report PDF' : 'Open report PDF'}</span></button>}
      {report.status === 'failed' ? <AlertTriangle size={18} className="is-danger" /> : <CheckCircle2 size={18} className="is-success" />}
      {error && <small role="alert">{error}</small>}
    </article>
  );
}

function locationName(observation: ClientObservation, sites: Array<{ id: string; name: string }>, zones: Array<{ id: string; name: string }>): string {
  return sites.find((site) => site.id === observation.site_id)?.name ?? zones.find((zone) => zone.id === observation.zone_id)?.name ?? 'Location not named';
}

function InvoiceRow({ invoice }: { invoice: ClientInvoice }) {
  const amount = invoice.total_amount == null ? '—' : `${invoice.currency ?? 'NZD'} ${Number(invoice.total_amount).toFixed(2)}`;
  return (
    <article className="client-report-row">
      <span><CalendarRange size={19} /></span>
      <div><strong>{invoice.invoice_number}</strong><small>{invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-NZ') : 'Date not set'}</small></div>
      <div><strong>{amount}</strong><small>{invoice.due_date ? `Due ${new Date(invoice.due_date).toLocaleDateString('en-NZ')}` : 'No due date'}</small></div>
      <div><strong>{invoice.status}</strong><small>{invoice.paid_at ? `Paid ${new Date(invoice.paid_at).toLocaleDateString('en-NZ')}` : invoice.sent_at ? `Sent ${new Date(invoice.sent_at).toLocaleDateString('en-NZ')}` : 'Not sent'}</small></div>
      {invoice.status === 'paid' ? <CheckCircle2 size={18} className="is-success" /> : <AlertTriangle size={18} className={invoice.status === 'overdue' ? 'is-danger' : ''} />}
    </article>
  );
}