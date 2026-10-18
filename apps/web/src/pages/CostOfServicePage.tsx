/**
 * CostOfServicePage — organisation-level recorded travel, for cost of service.
 *
 * Answers: "what did it cost us, in travel, to serve this client/place/officer
 * over this window?" — using distance officers actually recorded, not an
 * estimate. The figures are operational evidence. Pricing and invoicing stay
 * on the finance pipeline; nothing on this page writes.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import PatrolTravelSummary from '../components/PatrolTravelSummary';
import { supabase } from '../lib/supabase';
import { TRAVEL_WINDOW_OPTIONS } from '../lib/patrolTravel';
import './CostOfServicePage.css';

interface OfficerOption { id: string; label: string }
interface SiteOption { id: string; label: string }

const CostOfServicePage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;

  const [officers, setOfficers] = useState<OfficerOption[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [officerId, setOfficerId] = useState<string>('');
  const [siteId, setSiteId] = useState<string>('');
  const [monthsBack, setMonthsBack] = useState<number>(6);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(true);

  const loadScope = useCallback(async () => {
    if (!organizationId) {
      setScopeLoading(false);
      return;
    }
    setScopeLoading(true);
    setScopeError(null);
    // ATLAS READS: user_profiles, client_sites
    const [officerResponse, siteResponse] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, display_name, email')
        .eq('organization_id', organizationId)
        .in('role', ['officer', 'scan_operator', 'supervisor'])
        .order('display_name', { ascending: true }),
      supabase
        .from('client_sites')
        .select('id, name')
        .eq('organization_id', organizationId)
        .eq('active', true)
        .order('name', { ascending: true }),
    ]);
    const failure = officerResponse.error ?? siteResponse.error;
    if (failure) setScopeError(`Travel is still shown, but the filters are unavailable: ${failure.message}`);
    setOfficers(((officerResponse.data as Array<{ id: string; display_name: string | null; email: string | null }> | null) ?? [])
      .map((row) => ({ id: row.id, label: row.display_name || row.email || row.id })));
    setSites(((siteResponse.data as Array<{ id: string; name: string | null }> | null) ?? [])
      .map((row) => ({ id: row.id, label: row.name || row.id })));
    setScopeLoading(false);
  }, [organizationId]);

  useEffect(() => { void loadScope(); }, [loadScope]);

  const officerNames = useMemo(() => Object.fromEntries(officers.map((officer) => [officer.id, officer.label])), [officers]);
  const placeNames = useMemo(() => Object.fromEntries(sites.map((site) => [site.id, site.label])), [sites]);
  const scopeLabel = siteId ? placeNames[siteId] ?? 'the selected place' : 'all places';

  if (!organizationId) {
    return <div className="cost-of-service">
      <header className="cost-of-service-header"><div><span>Reports &amp; analytics</span><h1>Cost of service</h1></div></header>
      <p className="cost-of-service-message" role="status">
        <AlertTriangle size={17} aria-hidden="true" />
        No organisation is in context, so cost of service cannot be reported. Choose an organisation and try again.
      </p>
    </div>;
  }

  return <div className="cost-of-service">
    <header className="cost-of-service-header">
      <div>
        <span>Reports &amp; analytics</span>
        <h1><Gauge size={20} aria-hidden="true" />Cost of service</h1>
        <p>Travel officers recorded serving {scopeLabel}, over the last {monthsBack} months. Operational evidence for cost of service — not an invoice.</p>
      </div>
    </header>

    {scopeError && <p className="cost-of-service-message" role="alert"><AlertTriangle size={17} aria-hidden="true" />{scopeError}</p>}

    <div className="cost-of-service-filters" role="group" aria-label="Cost of service scope">
      <label>
        <span>Window</span>
        <select value={monthsBack} onChange={(event) => setMonthsBack(Number(event.target.value))}>
          {TRAVEL_WINDOW_OPTIONS.map((months) => <option value={months} key={months}>Last {months} months</option>)}
        </select>
      </label>
      <label>
        <span>Officer</span>
        <select value={officerId} onChange={(event) => setOfficerId(event.target.value)} disabled={scopeLoading}>
          <option value="">All officers</option>
          {officers.map((officer) => <option value={officer.id} key={officer.id}>{officer.label}</option>)}
        </select>
      </label>
      <label>
        <span>Place</span>
        <select value={siteId} onChange={(event) => setSiteId(event.target.value)} disabled={scopeLoading}>
          <option value="">All places</option>
          {sites.map((site) => <option value={site.id} key={site.id}>{site.label}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { setOfficerId(''); setSiteId(''); }} disabled={!officerId && !siteId}>Clear scope</button>
    </div>

    <PatrolTravelSummary
      organizationId={organizationId}
      monthsBack={monthsBack}
      officerId={officerId || null}
      siteId={siteId || null}
      officerNames={officerNames}
      placeNames={placeNames}
      title="Travel by month"
      description="Every month in the window, including months with no recorded travel omitted rather than shown as zero."
      breakdown="monthly"
    />

    <PatrolTravelSummary
      organizationId={organizationId}
      monthsBack={monthsBack}
      officerId={officerId || null}
      siteId={siteId || null}
      officerNames={officerNames}
      placeNames={placeNames}
      title="Travel by officer"
      description="Who carried the travel load in this window. Ranked by distance recorded."
      breakdown="officer"
    />
  </div>;
};

export default CostOfServicePage;
