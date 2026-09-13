/**
 * LocationsPage.tsx
 *
 * Canonical schema: locations ("house" — client-owned physical place) groups
 * a Site facet (client_sites, addressed point) and Zone facet(s)
 * (location_zones, area) as siblings via location_id. zone_closures track
 * temporary/prohibited closures per zone.
 */

import React, { useEffect, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import {
  LocationHouseMap,
  type HouseMapSite,
  type HouseMapZone,
} from "../components/LocationHouseMap";
import { OperationalPlaceManager } from "../components/OperationalPlaceManager";
import { readWorkflowContext, workflowContextQuery } from "../lib/workflowNavigation";
import "./PageStyles.css";
import "./GeographyPages.css";

interface LocationRow {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  postcode: string | null;
  notes: string | null;
}

interface SiteFacet extends HouseMapSite {
  id: string;
  name: string;
  site_type: string | null;
  active: boolean;
  location_id: string | null;
}

interface ZoneFacet extends HouseMapZone {
  id: string;
  name: string;
  zone_type: string;
  is_active: boolean;
  nightly_limit_consecutive: number | null;
  scv_required: boolean;
  location_id: string | null;
}

interface ZoneClosure {
  id: string;
  zone_id: string;
  closure_type: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
}

const LocationsPage: React.FC = () => {
  const navigate = useNavigate();
  const routerLocation = useLocation();
  const requestedLocationId = readWorkflowContext(routerLocation.search).locationId;
  const { profile } = useAuth();
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [selected, setSelected] = useState<LocationRow | null>(null);
  const [sites, setSites] = useState<SiteFacet[]>([]);
  const [zones, setZones] = useState<ZoneFacet[]>([]);
  const [operationalSites, setOperationalSites] = useState<SiteFacet[]>([]);
  const [operationalZones, setOperationalZones] = useState<ZoneFacet[]>([]);
  const [closures, setClosures] = useState<ZoneClosure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [managerDirty, setManagerDirty] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);

  // ATLAS READS: locations
  useEffect(() => {
    const loadLocations = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) {
        setLocations([]);
        setSites([]);
        setZones([]);
        setError('Organisation access could not be confirmed. Operational geography is unavailable.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase.rpc(
          "get_crm_operational_geography",
        );

        if (err) throw err;
        const geography = (data ?? {}) as {
          locations?: LocationRow[];
          sites?: SiteFacet[];
          zones?: ZoneFacet[];
        };
        const locationRows = geography.locations ?? [];
        setLocations(locationRows);
        setOperationalSites(geography.sites ?? []);
        setOperationalZones(geography.zones ?? []);

        if (locationRows.length > 0) {
          const nextSelected = locationRows.find((item) => item.id === requestedLocationId) ?? locationRows.find((item) => item.id === selected?.id) ?? locationRows[0];
          setSelected(nextSelected);
          await loadFacets(
            nextSelected.id,
            geography.sites ?? [],
            geography.zones ?? [],
          );
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load locations",
        );
      } finally {
        setLoading(false);
      }
    };

    loadLocations();
  }, [profile?.organizationId, refreshRevision, requestedLocationId]);

  const loadFacets = async (
    locationId: string,
    availableSites = operationalSites,
    availableZones = operationalZones,
  ) => {
    try {
      const siteRows = availableSites.filter(
        (site) => site.location_id === locationId,
      );
      const zoneRows = availableZones.filter(
        (zone) => zone.location_id === locationId,
      );
      setSites(siteRows);
      setZones(zoneRows);

      if (zoneRows.length > 0) {
        // ATLAS READS: zone_closures
        const { data: closureData, error: closureErr } = await supabase
          .from("zone_closures")
          .select(
            "id, zone_id, closure_type, status, effective_from, effective_to, reason",
          )
          .in(
            "zone_id",
            zoneRows.map((z) => z.id),
          )
          .eq("status", "active");

        if (closureErr) throw closureErr;
        setClosures((closureData as ZoneClosure[]) || []);
      } else {
        setClosures([]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load location facets",
      );
    }
  };

  const handleSelect = (location: LocationRow) => {
    setSelected(location);
    loadFacets(location.id);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading locations...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container geography-page">
      <header className="page-header">
        <div>
          <h1>Locations</h1>
          <p className="subtitle">
            {locations.length} locations · sites and zones grouped by physical
            place
          </p>
        </div>
        {selected && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setManaging(true)}
          >
            Manage location
          </button>
        )}
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button
            className="alert-close"
            onClick={() => setError(null)}
            aria-label="Close alert"
          >
            ×
          </button>
          {error}
        </div>
      )}

      <div className="smoke-layout">
        <div className="site-selector">
          <h2>All Locations ({locations.length})</h2>
          <div className="sites-list">
            {locations.length === 0 ? (
              <div className="empty-state">
                <p>No locations configured.</p>
              </div>
            ) : (
              locations.map((loc) => (
                <button
                  key={loc.id}
                  className={`site-card ${selected?.id === loc.id ? "active" : ""}`}
                  onClick={() => handleSelect(loc)}
                >
                  <h3>{loc.name}</h3>
                  <p className="site-address">
                    {loc.address}
                    {loc.suburb ? `, ${loc.suburb}` : ""}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {selected && (
          <div className="assessment-details">
            <div className="details-header">
              <h2>{selected.name}</h2>
            </div>

            {selected.notes && <p className="contact-meta">{selected.notes}</p>}

            <LocationHouseMap
              organizationId={selected.organization_id}
              house={{
                name: selected.name,
                address:
                  [selected.address, selected.suburb, selected.postcode]
                    .filter(Boolean)
                    .join(", ") || null,
              }}
              sites={sites}
              zones={zones}
            />

            <section className="reports-section">
              <h3>Site Facet ({sites.length})</h3>
              {sites.length === 0 ? (
                <div className="empty-state">
                  <p>No addressed site facet for this location.</p>
                </div>
              ) : (
                <div className="contacts-list">
                  {sites.map((site) => (
                    <div key={site.id} className="contact-card">
                      <div className="contact-header">
                        <h3>{site.name}</h3>
                        <span
                          className={`status-badge status-${site.active ? "active" : "inactive"}`}
                        >
                          {site.active ? "Active" : "Inactive"}
                        </span>
                      </div>
                      {site.site_type && (
                        <p className="contact-meta">{site.site_type}</p>
                      )}
                      <div className="assessment-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() =>
                            navigate(`/admin/site-360${workflowContextQuery({ accountId: selected.organization_id, locationId: selected.id, siteId: site.id })}`)
                          }
                        >
                          Open site
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => navigate(`/admin/document-studio?sourceType=site&sourceId=${encodeURIComponent(site.id)}&auto=1`)}
                          title="Draft a site safety plan with Bob"
                        >
                          Bob: Draft safety plan
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="reports-section">
              <h3>Zone Facet(s) ({zones.length})</h3>
              {zones.length === 0 ? (
                <div className="empty-state">
                  <p>No area/zone facet for this location.</p>
                </div>
              ) : (
                <div className="contacts-list">
                  {zones.map((zone) => {
                    const zoneClosures = closures.filter(
                      (c) => c.zone_id === zone.id,
                    );
                    return (
                      <div key={zone.id} className="contact-card">
                        <div className="contact-header">
                          <h3>{zone.name}</h3>
                          <span className="contact-type-badge">
                            {zone.zone_type}
                          </span>
                        </div>
                        <div className="contact-details">
                          <p className="contact-meta">
                            {zone.is_active ? "Active" : "Inactive"}
                            {zone.scv_required ? " · SCV required" : ""}
                            {zone.nightly_limit_consecutive
                              ? ` · limit ${zone.nightly_limit_consecutive} consecutive nights`
                              : ""}
                          </p>
                        </div>
                        {zoneClosures.length > 0 && (
                          <div className="assessment-actions">
                            {zoneClosures.map((c) => (
                              <span
                                key={c.id}
                                className="severity-badge severity-high"
                              >
                                {c.closure_type} since{" "}
                                {new Date(
                                  c.effective_from,
                                ).toLocaleDateString()}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="assessment-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() =>
                              navigate(`/admin/zones${workflowContextQuery({ accountId: selected.organization_id, locationId: selected.id, zoneId: zone.id })}`)
                            }
                          >
                            Open zone
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      {managing && selected && (
        <OperationalPlaceManager
          locationId={selected.id}
          onClose={() => { setManaging(false); if (managerDirty) { setManagerDirty(false); setRefreshRevision((revision) => revision + 1); } }}
          onSaved={() => setManagerDirty(true)}
        />
      )}
    </div>
  );
};

export default LocationsPage;
