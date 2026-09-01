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

const SiteDetailPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [selectedSite, setSelectedSite] = useState<ClientSite | null>(null);
  const [services, setServices] = useState<SiteService[]>([]);
  const [financial, setFinancial] = useState<FinancialConfig | null>(null);
  const [notes, setNotes] = useState<LocationNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [house, setHouse] = useState<{ name: string; address: string | null } | null>(null);
  const [zones, setZones] = useState<HouseMapZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: client_sites
  useEffect(() => {
    const loadSites = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;

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
      // ATLAS READS: site_services, site_financial_config, location_notes
      const [servicesRes, financialRes, notesRes] = await Promise.all([
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
      ]);

      if (servicesRes.error) throw servicesRes.error;
      if (financialRes.error) throw financialRes.error;
      if (notesRes.error) throw notesRes.error;

      setServices((servicesRes.data as SiteService[]) || []);
      setFinancial((financialRes.data as FinancialConfig) || null);
      setNotes((notesRes.data as LocationNote[]) || []);
      const currentSite = site ?? sites.find((row) => row.id === siteId);
      if (currentSite?.location_id) {
        const [houseRes, zonesRes] = await Promise.all([
          supabase.from('locations').select('name,address,suburb,postcode').eq('id', currentSite.location_id).single(),
          supabase.from('location_zones').select('id,name,boundary,center_point,boundary_status,boundary_verification').eq('location_id', currentSite.location_id),
        ]);
        if (houseRes.error) throw houseRes.error;
        if (zonesRes.error) throw zonesRes.error;
        const row = houseRes.data as { name: string; address: string | null; suburb: string | null; postcode: string | null };
        setHouse({ name: row.name, address: [row.address, row.suburb, row.postcode].filter(Boolean).join(', ') || null });
        setZones((zonesRes.data as HouseMapZone[]) ?? []);
      } else {
        setHouse({ name: currentSite?.name ?? 'Unlinked site', address: currentSite?.address ?? null });
        setZones([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load site detail');
    }
  };

  const handleSelectSite = (site: ClientSite) => {
    setSelectedSite(site);
    navigate(`/admin/site-360?site=${site.id}`, { replace: true });
    loadSiteDetail(site.id, site);
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
              <h2>{selectedSite.name}</h2>
              <span className={`status-badge status-${selectedSite.active ? 'active' : 'inactive'}`}>
                {selectedSite.active ? 'Active' : 'Inactive'}
              </span>
            </div>

            <div className="site-info">
              <div className="info-item">
                <label>Address</label>
                <p>{selectedSite.address || '—'}</p>
              </div>
              <div className="info-item">
                <label>Risk Level</label>
                <p>{selectedSite.risk_level || 'Not assessed'}</p>
              </div>
              {selectedSite.site_brief && (
                <div className="info-item">
                  <label>Briefing</label>
                  <p>{selectedSite.site_brief}</p>
                </div>
              )}
              {selectedSite.access_instructions && (
                <div className="info-item">
                  <label>Access Instructions</label>
                  <p>{selectedSite.access_instructions}</p>
                </div>
              )}
              {selectedSite.hs_notes && (
                <div className="info-item">
                  <label>Health & Safety Notes</label>
                  <p>{selectedSite.hs_notes}</p>
                </div>
              )}
            </div>

            {house && <LocationHouseMap organizationId={profile?.organizationId ?? ''} house={house} sites={[selectedSite]} zones={zones} />}

            {zones.length > 0 && <section className="reports-section"><h3>Zone facets ({zones.length})</h3><div className="contacts-list">{zones.map((zone) => <div className="contact-card" key={zone.id}><div className="contact-header"><h3>{zone.name}</h3><span className={`status-badge status-${zone.boundary_verification === 'verified' ? 'active' : 'inactive'}`}>{zone.boundary_verification}</span></div><div className="assessment-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => navigate(`/admin/zones${workflowContextQuery({ accountId: selectedSite.client_organization_id, locationId: selectedSite.location_id ?? undefined, siteId: selectedSite.id, zoneId: zone.id })}`)}>Open zone</button></div></div>)}</div></section>}

            <section className="reports-section">
              <h3>Services ({services.length})</h3>
              {services.length === 0 ? (
                <div className="empty-state">
                  <p>No services configured for this site.</p>
                </div>
              ) : (
                <div className="contacts-list">
                  {services.map((service) => (
                    <div key={service.id} className="contact-card">
                      <div className="contact-header">
                        <h3>{service.module_key}</h3>
                        <button
                          className={`btn btn-sm ${service.enabled ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => handleToggleService(service)}
                        >
                          {service.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      </div>
                      {service.response_sla_minutes && (
                        <p className="contact-meta">SLA: {service.response_sla_minutes} minutes</p>
                      )}
                      {service.special_instructions && <p>{service.special_instructions}</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {financial && (
              <section className="reports-section">
                <h3>Billing</h3>
                <div className="contact-card">
                  <p>
                    Model: {financial.billing_model} · Terms: {financial.payment_terms_days} days
                  </p>
                  {financial.hourly_rate && <p>Hourly rate: ${financial.hourly_rate}</p>}
                  {financial.per_visit_rate && <p>Per visit: ${financial.per_visit_rate}</p>}
                  {financial.flat_rate_monthly && <p>Flat monthly: ${financial.flat_rate_monthly}</p>}
                </div>
              </section>
            )}

            <section className="reports-section">
              <h3>Notes ({notes.length})</h3>
              <form className="assessment-form" onSubmit={handleAddNote}>
                <div className="form-group">
                  <textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Add a note about this site..."
                    rows={3}
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-sm">
                  Add Note
                </button>
              </form>
              <div className="contacts-list" style={{ marginTop: '12px' }}>
                {notes.map((note) => (
                  <div key={note.id} className="contact-card">
                    <p>{note.body}</p>
                    <p className="contact-meta">{new Date(note.created_at).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default SiteDetailPage;
