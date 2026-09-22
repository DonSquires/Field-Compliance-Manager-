/**
 * SiteDetailPage.tsx
 *
 * Canonical schema: client_sites (address, gps, risk, briefing) + site_services
 * (per-site module enablement + SLA) + site_financial_config (billing model,
 * rates) + location_notes (free-text site notes). Sites belong to an
 * organization via client_organization_id.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { workflowContextQuery } from '../lib/workflowNavigation';
import { LocationHouseMap, type HouseMapZone } from '../components/LocationHouseMap';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import './PageStyles.css';
import './GeographyPages.css';

interface ClientSite {
  id: string;
  client_organization_id: string;
  name: string;
  address: string | null;
  site_type: string | null;
  risk_level: string | null;
  site_brief: string | null;
  access_instructions: string | null;
  hs_notes: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  active: boolean;
  location_id: string | null;
  boundary: GeoJSON.GeoJsonObject | null;
  boundary_status: string;
  boundary_verification: string;
}

interface SiteService {
  id: string;
  module_key: string;
  enabled: boolean;
  response_sla_minutes: number | null;
  special_instructions: string | null;
}

interface FinancialConfig {
  id: string;
  billing_model: string;
  hourly_rate: number | null;
  per_visit_rate: number | null;
  flat_rate_monthly: number | null;
  payment_terms_days: number;
}

interface LocationNote {
  id: string;
  body: string;
  created_at: string;
}

interface PatrolRoute { id: string; name: string; route_type: string; default_shift: string | null; is_active: boolean; guards_required: number; }
interface RosterShift { id: string; officer_user_id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; officer: Array<{ display_name: string | null; email: string | null }> | null; }
interface SiteContact { id: string; first_name: string; last_name: string; role_title: string | null; email: string | null; phone: string | null; mobile: string | null; is_primary: boolean; is_emergency: boolean; }
interface SiteContract { id: string; status: string; share_contract_price: boolean | null; share_actual_cost: boolean | null; agreement: Array<{ name: string; agreement_type: string; invitation_status: string }> | null; }
interface ActivityEventRow { id: string; event_type: string; module_key: string | null; occurred_at: string; status: string | null; source: string | null; payload: Record<string, unknown> | null; }

type SiteWorkspaceTab = 'overview' | 'services' | 'zones' | 'routes' | 'roster' | 'contacts' | 'contracts' | 'finance' | 'notes' | 'activity';

const SiteDetailPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [selectedSite, setSelectedSite] = useState<ClientSite | null>(null);
  const [services, setServices] = useState<SiteService[]>([]);
  const [financial, setFinancial] = useState<FinancialConfig | null>(null);
  const [notes, setNotes] = useState<LocationNote[]>([]);
  const [patrolRoutes, setPatrolRoutes] = useState<PatrolRoute[]>([]);
  const [rosterShifts, setRosterShifts] = useState<RosterShift[]>([]);
  const [contacts, setContacts] = useState<SiteContact[]>([]);
  const [contracts, setContracts] = useState<SiteContract[]>([]);
  const [recentActivity, setRecentActivity] = useState<ActivityEventRow[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<SiteWorkspaceTab>('overview');
  const [newNote, setNewNote] = useState('');
  const [house, setHouse] = useState<{ name: string; address: string | null } | null>(null);
  const [zones, setZones] = useState<HouseMapZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: client_sites
  useEffect(() => {
    const loadSites = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) {
        setSites([]);
        setSelectedSite(null);
        setError('Organisation access could not be confirmed. Site data is unavailable.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase.rpc('get_crm_operational_geography');

        if (err) throw err;
        const siteRows = ((data as { sites?: ClientSite[] } | null)?.sites) ?? [];
        setSites(siteRows);

        if (siteRows.length > 0) {
          const requestedId = new URLSearchParams(location.search).get('site');
          const initialSite = siteRows.find((site) => site.id === requestedId) ?? siteRows[0];
          setSelectedSite(initialSite);
          await loadSiteDetail(initialSite.id, initialSite);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sites');
      } finally {
        setLoading(false);
      }
    };

    loadSites();
  }, [profile?.organizationId, location.search]);

  const loadSiteDetail = async (siteId: string, site?: ClientSite) => {
    try {
      // ATLAS READS: site_services, site_financial_config, location_notes, patrol_routes, shifts, crm_contacts, service_agreement_locations, location_events
      const [servicesRes, financialRes, notesRes, routesRes, contactsRes, contractsRes, activityRes] = await Promise.all([
        supabase
          .from('site_services')
          .select('id, module_key, enabled, response_sla_minutes, special_instructions')
          .eq('site_id', siteId),
        supabase
          .from('site_financial_config')
          .select('id, billing_model, hourly_rate, per_visit_rate, flat_rate_monthly, payment_terms_days')
          .eq('site_id', siteId)
          .maybeSingle(),
        supabase
          .from('location_notes')
          .select('id, body, created_at')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false }),
        supabase.from('patrol_routes').select('id,name,route_type,default_shift,is_active,guards_required').eq('site_id', siteId).order('name'),
        supabase.from('crm_contacts').select('id,first_name,last_name,role_title,email,phone,mobile,is_primary,is_emergency').eq('organization_id', (site ?? sites.find((row) => row.id === siteId))?.client_organization_id ?? '').order('is_primary', { ascending: false }).order('last_name'),
        supabase.from('service_agreement_locations').select('id,status,share_contract_price,share_actual_cost,agreement:service_agreement_id(name,agreement_type,invitation_status)').eq('site_id', siteId).order('created_at', { ascending: false }),
        supabase.from('location_events').select('id,event_type,module_key,occurred_at,status,source,payload').eq('client_site_id', siteId).order('occurred_at', { ascending: false }).limit(25),
      ]);

      if (servicesRes.error) throw servicesRes.error;
      if (financialRes.error) throw financialRes.error;
      if (notesRes.error) throw notesRes.error;
      if (routesRes.error) throw routesRes.error;
      if (contactsRes.error) throw contactsRes.error;
      if (contractsRes.error) throw contractsRes.error;
      if (activityRes.error) throw activityRes.error;

      setServices((servicesRes.data as SiteService[]) || []);
      setFinancial((financialRes.data as FinancialConfig) || null);
      setNotes((notesRes.data as LocationNote[]) || []);
      setPatrolRoutes((routesRes.data as PatrolRoute[]) || []);
      setContacts((contactsRes.data as SiteContact[]) || []);
      setContracts((contractsRes.data as SiteContract[]) || []);
      setRecentActivity((activityRes.data as ActivityEventRow[]) || []);
      const currentSite = site ?? sites.find((row) => row.id === siteId);
      if (currentSite?.location_id) {
        const [houseRes, zonesRes, shiftsRes] = await Promise.all([
          supabase.from('locations').select('name,address,suburb,postcode').eq('id', currentSite.location_id).single(),
          supabase.from('location_zones').select('id,name,boundary,center_point,boundary_status,boundary_verification').eq('location_id', currentSite.location_id),
          supabase.from('shifts').select('id,officer_user_id,service_type,scheduled_start,scheduled_end,status,officer:officer_user_id(display_name,email)').eq('location_id', currentSite.location_id).in('status', ['scheduled','published','accepted','in_progress']).order('scheduled_start').limit(50),
        ]);
        if (houseRes.error) throw houseRes.error;
        if (zonesRes.error) throw zonesRes.error;
        if (shiftsRes.error) throw shiftsRes.error;
        const row = houseRes.data as { name: string; address: string | null; suburb: string | null; postcode: string | null };
        setHouse({ name: row.name, address: [row.address, row.suburb, row.postcode].filter(Boolean).join(', ') || null });
        setZones((zonesRes.data as HouseMapZone[]) ?? []);
        setRosterShifts((shiftsRes.data as RosterShift[]) ?? []);
      } else {
        setHouse({ name: currentSite?.name ?? 'Unlinked site', address: currentSite?.address ?? null });
        setZones([]);
        setRosterShifts([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load site detail');
    }
  };

  const handleSelectSite = (site: ClientSite) => {
    setSelectedSite(site);
    setWorkspaceTab('overview');
    navigate(`/admin/site-360?site=${site.id}`, { replace: true });
    loadSiteDetail(site.id, site);
  };

  const refreshSiteBoundary = async (siteId: string) => {
    // ATLAS READS: client_sites (re-sync the boundary badge after an inline save from LocationHouseMap)
    const { data } = await supabase.from('client_sites').select('id,boundary,boundary_status,boundary_verification,gps_lat,gps_lng').eq('id', siteId).maybeSingle();
    if (!data) return;
    setSelectedSite((current) => (current && current.id === siteId ? ({ ...current, ...data } as ClientSite) : current));
    setSites((current) => current.map((site) => (site.id === siteId ? ({ ...site, ...data } as ClientSite) : site)));
  };

  const handleToggleService = async (service: SiteService) => {
    try {
      // ATLAS WRITES: site_services
      const { error } = await supabase
        .from('site_services')
        .update({ enabled: !service.enabled })
        .eq('id', service.id);

      if (error) throw error;
      setServices(services.map((s) => (s.id === service.id ? { ...s, enabled: !s.enabled } : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update service');
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSite || !profile?.organizationId || !newNote.trim()) return;

    try {
      // ATLAS WRITES: location_notes
      const { data, error } = await supabase
        .from('location_notes')
        .insert([
          {
            site_id: selectedSite.id,
            organization_id: profile.organizationId,
            body: newNote.trim(),
            created_by: profile.id,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setNotes([data as LocationNote, ...notes]);
      setNewNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add note');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading sites...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container geography-page">
      <header className="page-header">
        <h1>Sites</h1>
        <p className="subtitle">{sites.length} sites in this organisation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="smoke-layout">
        <div className="site-selector">
          <h2>All Sites ({sites.length})</h2>
          <div className="sites-list">
            {sites.length === 0 ? (
              <div className="empty-state">
                <p>No sites configured.</p>
              </div>
            ) : (
              sites.map((site) => (
                <button
                  key={site.id}
                  className={`site-card ${selectedSite?.id === site.id ? 'active' : ''}`}
                  onClick={() => handleSelectSite(site)}
                >
                  <h3>{site.name}</h3>
                  <p className="site-address">{site.address}</p>
                  {site.site_type && <span className="site-type-badge">{site.site_type}</span>}
                </button>
              ))
            )}
          </div>
        </div>

        {selectedSite && (
          <div className="assessment-details">
            <div className="details-header">
              <div><span className="site-workspace-eyebrow">{house?.name ?? 'Operational place'}</span><h2>{selectedSite.name}</h2><p>{selectedSite.address ?? 'Address not recorded'} · {selectedSite.site_type ?? 'Site'}</p></div>
              <span className={`status-badge status-${selectedSite.active ? 'active' : 'inactive'}`}>
                {selectedSite.active ? 'Active' : 'Inactive'}
              </span>
            </div>
            <nav className="site-workspace-tabs" aria-label="Site workspace"><button type="button" className={workspaceTab === 'overview' ? 'is-active' : ''} onClick={() => setWorkspaceTab('overview')}>Overview</button><button type="button" className={workspaceTab === 'services' ? 'is-active' : ''} onClick={() => setWorkspaceTab('services')}>Services <strong>{services.length}</strong></button><button type="button" className={workspaceTab === 'zones' ? 'is-active' : ''} onClick={() => setWorkspaceTab('zones')}>Zones <strong>{zones.length}</strong></button><button type="button" className={workspaceTab === 'routes' ? 'is-active' : ''} onClick={() => setWorkspaceTab('routes')}>Patrol routes <strong>{patrolRoutes.length}</strong></button><button type="button" className={workspaceTab === 'roster' ? 'is-active' : ''} onClick={() => setWorkspaceTab('roster')}>Active roster <strong>{rosterShifts.length}</strong></button><button type="button" className={workspaceTab === 'contacts' ? 'is-active' : ''} onClick={() => setWorkspaceTab('contacts')}>Contacts <strong>{contacts.length}</strong></button><button type="button" className={workspaceTab === 'contracts' ? 'is-active' : ''} onClick={() => setWorkspaceTab('contracts')}>Contracts <strong>{contracts.length}</strong></button><button type="button" className={workspaceTab === 'finance' ? 'is-active' : ''} onClick={() => setWorkspaceTab('finance')}>Finance</button><button type="button" className={workspaceTab === 'notes' ? 'is-active' : ''} onClick={() => setWorkspaceTab('notes')}>Notes <strong>{notes.length}</strong></button><button type="button" className={workspaceTab === 'activity' ? 'is-active' : ''} onClick={() => setWorkspaceTab('activity')}>Activity <strong>{recentActivity.length}</strong></button></nav>
            <div className="site-workspace-body">
              {workspaceTab === 'overview' && <><div className="site-info"><div className="info-item"><label>Risk level</label><p>{selectedSite.risk_level || 'Not assessed'}</p></div><div className="info-item"><label>Boundary</label><p>{selectedSite.boundary_status} · {selectedSite.boundary_verification}</p></div><div className="info-item"><label>Services</label><p>{services.filter((service) => service.enabled).length} active</p></div><div className="info-item"><label>Rostered staff</label><p>{new Set(rosterShifts.map((shift) => shift.officer_user_id)).size}</p></div><div className="info-item"><label>Site brief</label><p>{selectedSite.site_brief || 'No site brief recorded.'}</p></div><div className="info-item"><label>Access instructions</label><p>{selectedSite.access_instructions || 'No access instructions recorded.'}</p></div><div className="info-item"><label>H&S notes</label><p>{selectedSite.hs_notes || 'No H&S notes recorded.'}</p></div></div><SafetyWarningsPanel entityType="site" entityId={selectedSite.id} entityLabel="this place" />{house && <LocationHouseMap organizationId={profile?.organizationId ?? ''} house={house} sites={[selectedSite]} zones={zones} editableEntity={{ type: 'client_site', id: selectedSite.id, organizationId: selectedSite.client_organization_id, centerLat: selectedSite.gps_lat, centerLng: selectedSite.gps_lng, onSaved: () => void refreshSiteBoundary(selectedSite.id) }} />}</>}
              {workspaceTab === 'services' && <section className="reports-section"><h3>Services required at this site</h3><div className="contacts-list">{services.length === 0 ? <div className="empty-state"><p>No services configured for this site.</p></div> : services.map((service) => <div key={service.id} className="contact-card"><div className="contact-header"><h3>{service.module_key}</h3><button className={`btn btn-sm ${service.enabled ? 'btn-primary' : 'btn-secondary'}`} onClick={() => handleToggleService(service)}>{service.enabled ? 'Enabled' : 'Disabled'}</button></div>{service.response_sla_minutes && <p className="contact-meta">SLA: {service.response_sla_minutes} minutes</p>}{service.special_instructions && <p>{service.special_instructions}</p>}</div>)}</div></section>}
              {workspaceTab === 'zones' && <section className="reports-section"><h3>Sibling zone facets at this location</h3><div className="contacts-list">{zones.length === 0 ? <div className="empty-state"><p>No zones configured. Manage them in Locations.</p></div> : zones.map((zone) => <div className="contact-card" key={zone.id}><div className="contact-header"><h3>{zone.name}</h3><span className={`status-badge status-${zone.boundary_verification === 'verified' ? 'active' : 'inactive'}`}>{zone.boundary_verification}</span></div><button type="button" className="btn btn-sm btn-secondary" onClick={() => navigate(`/admin/zones${workflowContextQuery({ accountId: selectedSite.client_organization_id, locationId: selectedSite.location_id ?? undefined, siteId: selectedSite.id, zoneId: zone.id })}`)}>Open zone</button></div>)}</div></section>}
              {workspaceTab === 'routes' && <section className="reports-section"><h3>Patrol routes</h3><div className="contacts-list">{patrolRoutes.length === 0 ? <div className="empty-state"><p>No patrol routes configured for this site.</p></div> : patrolRoutes.map((route) => <div className="contact-card" key={route.id}><div className="contact-header"><h3>{route.name}</h3><span className={`status-badge status-${route.is_active ? 'active' : 'inactive'}`}>{route.is_active ? 'Active' : 'Inactive'}</span></div><p>{route.route_type} · {route.guards_required} required</p><p className="contact-meta">{route.default_shift ?? 'No default shift'}</p></div>)}</div></section>}
              {workspaceTab === 'roster' && <section className="reports-section"><h3>Staff currently rostered here</h3><div className="contacts-list">{rosterShifts.length === 0 ? <div className="empty-state"><p>No active roster assignments at this location.</p></div> : rosterShifts.map((shift) => <div className="contact-card" key={shift.id}><div className="contact-header"><h3>{shift.officer?.[0]?.display_name ?? shift.officer?.[0]?.email ?? 'Officer'}</h3><span className={`status-badge status-${shift.status}`}>{shift.status}</span></div><p>{shift.service_type} · {new Date(shift.scheduled_start).toLocaleString('en-NZ')}</p><p className="contact-meta">Ends {new Date(shift.scheduled_end).toLocaleString('en-NZ')}</p></div>)}</div></section>}
              {workspaceTab === 'contacts' && <section className="reports-section"><h3>Account contacts</h3><div className="contacts-list">{contacts.length === 0 ? <div className="empty-state"><p>No contacts recorded for this site's organization.</p></div> : contacts.map((contact) => <div className="contact-card" key={contact.id}><div className="contact-header"><h3>{contact.first_name} {contact.last_name}</h3>{contact.is_primary && <span className="contact-type-badge">Primary</span>}</div><p>{contact.role_title ?? 'Role not recorded'}</p><p className="contact-meta">{contact.email ?? contact.mobile ?? contact.phone ?? 'No contact method recorded'}</p></div>)}</div></section>}
              {workspaceTab === 'contracts' && <section className="reports-section"><h3>Contracts anchored to this site</h3><div className="contacts-list">{contracts.length === 0 ? <div className="empty-state"><p>No location-level contracts. Self-managed services may still be active.</p></div> : contracts.map((contract) => <div className="contact-card" key={contract.id}><div className="contact-header"><h3>{contract.agreement?.[0]?.name ?? 'Agreement unavailable'}</h3><span className={`status-badge status-${contract.status}`}>{contract.status}</span></div><p>{contract.agreement?.[0]?.agreement_type ?? 'Agreement'} · {contract.agreement?.[0]?.invitation_status ?? 'Unknown'}</p><p className="contact-meta">Contract price: {contract.share_contract_price ? 'shared' : 'private'} · Actual cost: {contract.share_actual_cost ? 'shared' : 'private'}</p></div>)}</div></section>}
              {workspaceTab === 'finance' && <section className="reports-section"><h3>Site financial configuration</h3>{financial ? <div className="site-info"><div className="info-item"><label>Billing model</label><p>{financial.billing_model}</p></div><div className="info-item"><label>Payment terms</label><p>{financial.payment_terms_days} days</p></div>{financial.hourly_rate != null && <div className="info-item"><label>Hourly rate</label><p>NZ${financial.hourly_rate}</p></div>}{financial.per_visit_rate != null && <div className="info-item"><label>Per visit</label><p>NZ${financial.per_visit_rate}</p></div>}{financial.flat_rate_monthly != null && <div className="info-item"><label>Monthly rate</label><p>NZ${financial.flat_rate_monthly}</p></div>}</div> : <div className="empty-state"><p>No site financial configuration recorded.</p></div>}</section>}
              {workspaceTab === 'notes' && <section className="reports-section"><h3>Operational notes</h3><form className="assessment-form" onSubmit={handleAddNote}><div className="form-group"><textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Add a note about this site..." rows={3} /></div><button type="submit" className="btn btn-primary btn-sm">Add note</button></form><div className="contacts-list" style={{ marginTop: '12px' }}>{notes.length === 0 ? <div className="empty-state"><p>No notes recorded.</p></div> : notes.map((note) => <div key={note.id} className="contact-card"><p>{note.body}</p><p className="contact-meta">{new Date(note.created_at).toLocaleString()}</p></div>)}</div></section>}
              {workspaceTab === 'activity' && <section className="reports-section"><h3>Recent activity</h3><div className="contacts-list">{recentActivity.length === 0 ? <div className="empty-state"><p>No recorded activity for this site yet.</p></div> : recentActivity.map((event) => { const payload = event.payload ?? {}; const summary = (typeof payload.description === 'string' && payload.description) || (typeof payload.comments === 'string' && payload.comments) || (typeof payload.patroller === 'string' && `Patroller: ${payload.patroller}`) || 'No further detail recorded'; return <div key={event.id} className="contact-card"><div className="contact-header"><h3>{event.event_type.replaceAll('_', ' ')}</h3>{event.status && <span className="status-badge status-active">{event.status}</span>}</div><p>{summary}</p><p className="contact-meta">{event.module_key ?? 'module not recorded'} · {event.source ?? 'source not recorded'} · {new Date(event.occurred_at).toLocaleString('en-NZ')}</p></div>; })}</div></section>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SiteDetailPage;
