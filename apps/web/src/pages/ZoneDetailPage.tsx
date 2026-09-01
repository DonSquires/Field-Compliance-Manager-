import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, LandPlot, MapPin } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import {
  LocationHouseMap,
  type HouseMapSite,
  type HouseMapZone,
} from "../components/LocationHouseMap";
import { OperationalPlaceManager } from "../components/OperationalPlaceManager";
import "./PageStyles.css";
import "./GeographyPages.css";
import "./ZoneDetailPage.css";

interface ZoneRow extends HouseMapZone {
  organization_id: string;
  location_id: string | null;
  site_id: string | null;
  zone_type: string;
  module_key: string;
  rule_type: string;
  is_active: boolean;
  active_schedule: Record<string, unknown> | null;
  onsite_profile: string;
  enforcement_workflow_override: string | null;
  address: string | null;
  bylaw_clause: string | null;
  bylaw_source_url: string | null;
  jurisdiction_rule_set_id: string | null;
  nightly_limit_consecutive: number | null;
  nightly_limit_monthly: number | null;
  scv_required: boolean;
}

interface ClosureRow {
  id: string;
  closure_type: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
}
interface BoundaryEvent {
  id: string;
  boundary_source: string | null;
  verification_state: string | null;
  changed_via: string;
  change_reason: string | null;
  version: number;
  created_at: string;
  has_boundary: boolean;
}
interface OperationalLocation {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  postcode: string | null;
}
interface OperationalSite extends HouseMapSite {
  location_id: string | null;
}

export default function ZoneDetailPage() {
  const { profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [selected, setSelected] = useState<ZoneRow | null>(null);
  const [house, setHouse] = useState<{
    name: string;
    address: string | null;
  } | null>(null);
  const [sites, setSites] = useState<HouseMapSite[]>([]);
  const [closures, setClosures] = useState<ClosureRow[]>([]);
  const [boundaryHistory, setBoundaryHistory] = useState<BoundaryEvent[]>([]);
  const [operationalLocations, setOperationalLocations] = useState<
    OperationalLocation[]
  >([]);
  const [operationalSites, setOperationalSites] = useState<OperationalSite[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [managerDirty, setManagerDirty] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [bylawForm, setBylawForm] = useState({ bylaw_clause: '', bylaw_source_url: '' });
  const [savingBylaw, setSavingBylaw] = useState(false);
  const [ruleSets, setRuleSets] = useState<Array<{ id: string; name: string; module_key: string }>>([]);
  const [ruleSetId, setRuleSetId] = useState<string>('');

  useEffect(() => {
    const load = async () => {
      if (!profile?.organizationId) return;
      setLoading(true);
      setError(null);
      const { data, error: zonesError } = await supabase.rpc(
        "get_crm_operational_geography",
      );
      if (zonesError) {
        setError(zonesError.message);
        setLoading(false);
        return;
      }
      const geography = (data ?? {}) as {
        locations?: OperationalLocation[];
        sites?: OperationalSite[];
        zones?: ZoneRow[];
      };
      const rows = geography.zones ?? [];
      setOperationalLocations(geography.locations ?? []);
      setOperationalSites(geography.sites ?? []);
      const requested = new URLSearchParams(location.search).get("zone");
      const initial =
        rows.find((zone) => zone.id === requested) ?? rows[0] ?? null;
      setZones(rows);
      setSelected(initial);
      if (initial)
        await loadContext(
          initial,
          geography.locations ?? [],
          geography.sites ?? [],
        );
      setLoading(false);
    };
    void load();
  }, [profile?.organizationId, location.search, refreshRevision]);

  const loadContext = async (
    zone: ZoneRow,
    availableLocations = operationalLocations,
    availableSites = operationalSites,
  ) => {
    const [closuresRes, historyRes] = await Promise.all([
      supabase
        .from("zone_closures")
        .select("id,closure_type,status,effective_from,effective_to,reason")
        .eq("zone_id", zone.id)
        .order("effective_from", { ascending: false }),
      supabase.rpc("get_boundary_history", {
        p_entity_type: "location_zone",
        p_entity_id: zone.id,
      }),
    ]);
    if (closuresRes.error || historyRes.error) {
      setError(
        closuresRes.error?.message ??
          historyRes.error?.message ??
          "Zone context failed to load",
      );
      return;
    }
    const row =
      availableLocations.find((item) => item.id === zone.location_id) ?? null;
    setHouse(
      row
        ? {
            name: row.name,
            address:
              [row.address, row.suburb, row.postcode]
                .filter(Boolean)
                .join(", ") || null,
          }
        : { name: zone.name, address: zone.address },
    );
    setSites(
      availableSites.filter((site) =>
        zone.location_id
          ? site.location_id === zone.location_id
          : site.id === zone.site_id,
      ),
    );
    setClosures((closuresRes.data as ClosureRow[]) ?? []);
    setBoundaryHistory((historyRes.data as BoundaryEvent[]) ?? []);
  };

  const selectZone = (zone: ZoneRow) => {
    setSelected(zone);
    navigate(`/admin/zones?zone=${zone.id}`, { replace: true });
    void loadContext(zone);
  };

  useEffect(() => {
    setBylawForm({ bylaw_clause: selected?.bylaw_clause ?? '', bylaw_source_url: selected?.bylaw_source_url ?? '' });
    setRuleSetId(selected?.jurisdiction_rule_set_id ?? '');
  }, [selected]);

  // ATLAS READS: jurisdiction_rule_sets
  useEffect(() => {
    const loadRuleSets = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;
      const { data } = await supabase
        .from('jurisdiction_rule_sets')
        .select('id, name, module_key')
        .eq('organization_id', orgId)
        .order('name');
      setRuleSets((data as Array<{ id: string; name: string; module_key: string }>) ?? []);
    };
    void loadRuleSets();
  }, [profile?.organizationId]);

  const handleSaveBylaw = async () => {
    if (!selected || savingBylaw) return;
    setSavingBylaw(true);
    setError(null);
    // ATLAS WRITES: location_zones
    const { error: updateError } = await supabase
      .from('location_zones')
      .update({
        bylaw_clause: bylawForm.bylaw_clause.trim() || null,
        bylaw_source_url: bylawForm.bylaw_source_url.trim() || null,
        jurisdiction_rule_set_id: ruleSetId || null,
      })
      .eq('id', selected.id);
    if (updateError) {
      setError(updateError.message);
    } else {
      const updated = { ...selected, bylaw_clause: bylawForm.bylaw_clause.trim() || null, bylaw_source_url: bylawForm.bylaw_source_url.trim() || null, jurisdiction_rule_set_id: ruleSetId || null };
      setSelected(updated);
      setZones(zones.map((z) => (z.id === updated.id ? updated : z)));
    }
    setSavingBylaw(false);
  };

  if (loading)
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading zones...</p>
        </div>
      </div>
    );
  return (
    <div className="page-container zone-detail-page">
      <header className="page-header">
        <div>
          <h1>Zones</h1>
          <p className="subtitle">
            Area facets, legal rules, closures, and boundary provenance
          </p>
        </div>
        <div className="assessment-actions">
          {selected && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setManaging(true)}
            >
              Manage selected zone
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate("/admin/sites")}
          >
            <LandPlot size={15} />
            Boundary review
          </button>
        </div>
      </header>
      {error && (
        <div className="alert alert-error" role="alert">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}
      <div className="smoke-layout">
        <aside className="site-selector">
          <h2>All Zones ({zones.length})</h2>
          <div className="sites-list">
            {zones.map((zone) => (
              <button
                type="button"
                key={zone.id}
                className={`site-card ${selected?.id === zone.id ? "active" : ""}`}
                onClick={() => selectZone(zone)}
              >
                <h3>{zone.name}</h3>
                <p className="site-address">
                  {zone.zone_type.replaceAll("_", " ")} ·{" "}
                  {zone.boundary_verification}
                </p>
              </button>
            ))}
          </div>
        </aside>
        {selected && house && (
          <main className="assessment-details">
            <div className="details-header">
              <div>
                <span className="contact-type-badge">
                  {selected.module_key.replaceAll("_", " ")}
                </span>
                <h2>{selected.name}</h2>
              </div>
              <span
                className={`status-badge status-${selected.is_active ? "active" : "inactive"}`}
              >
                {selected.is_active ? "Active" : "Inactive"}
              </span>
            </div>
            <LocationHouseMap
              organizationId={profile?.organizationId ?? ""}
              house={house}
              sites={sites}
              zones={[selected]}
            />
            <section className="zone-facts">
              <article>
                <span>Rule</span>
                <strong>{selected.rule_type.replaceAll("_", " ")}</strong>
              </article>
              <article>
                <span>Boundary</span>
                <strong>
                  {selected.boundary_status} · {selected.boundary_verification}
                </strong>
              </article>
              <article>
                <span>On-site profile</span>
                <strong>{selected.onsite_profile.replaceAll("_", " ")}</strong>
              </article>
              <article>
                <span>Workflow</span>
                <strong>
                  {selected.enforcement_workflow_override?.replaceAll(
                    "_",
                    " ",
                  ) ?? "Organization default"}
                </strong>
              </article>
              <article>
                <span>Active schedule</span>
                <strong>
                  {selected.active_schedule
                    ? JSON.stringify(selected.active_schedule)
                    : "Always active"}
                </strong>
              </article>
              <article>
                <span>Night limits</span>
                <strong>
                  {selected.nightly_limit_consecutive ?? "—"} consecutive ·{" "}
                  {selected.nightly_limit_monthly ?? "—"} monthly
                </strong>
              </article>
              <article>
                <span>SCV</span>
                <strong>
                  {selected.scv_required ? "Required" : "Not required"}
                </strong>
              </article>
            </section>
            <section className="reports-section">
              <h3>Legal authority</h3>
              <div className="form-group">
                <label>Bylaw clause</label>
                <textarea
                  rows={2}
                  value={bylawForm.bylaw_clause}
                  onChange={(e) => setBylawForm({ ...bylawForm, bylaw_clause: e.target.value })}
                  placeholder="e.g. Reserves and Beaches Bylaw 2020, clause 12.3"
                />
              </div>
              <div className="form-group">
                <label>Source URL</label>
                <input
                  value={bylawForm.bylaw_source_url}
                  onChange={(e) => setBylawForm({ ...bylawForm, bylaw_source_url: e.target.value })}
                  placeholder="https://…"
                />
              </div>
              <div className="form-group">
                <label>Jurisdiction rule set</label>
                <select value={ruleSetId} onChange={(e) => setRuleSetId(e.target.value)}>
                  <option value="">None linked</option>
                  {ruleSets.map((rs) => (
                    <option key={rs.id} value={rs.id}>
                      {rs.name} ({rs.module_key.replaceAll('_', ' ')})
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveBylaw()} disabled={savingBylaw}>
                {savingBylaw ? 'Saving…' : 'Save Legal Authority'}
              </button>
              {selected.bylaw_source_url && (
                <p>
                  <a href={selected.bylaw_source_url} target="_blank" rel="noreferrer">
                    Open current source bylaw
                  </a>
                </p>
              )}
            </section>
            <section className="reports-section">
              <h3>Closure history ({closures.length})</h3>
              {closures.length ? (
                <div className="contacts-list">
                  {closures.map((closure) => (
                    <article className="contact-card" key={closure.id}>
                      <div className="contact-header">
                        <strong>
                          {closure.closure_type.replaceAll("_", " ")}
                        </strong>
                        <span
                          className={`status-badge status-${closure.status === "active" ? "inactive" : "active"}`}
                        >
                          {closure.status}
                        </span>
                      </div>
                      <p>{closure.reason ?? "No reason recorded"}</p>
                      <small>
                        {new Date(closure.effective_from).toLocaleDateString(
                          "en-NZ",
                        )}
                        {closure.effective_to
                          ? ` to ${new Date(closure.effective_to).toLocaleDateString("en-NZ")}`
                          : ""}
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <MapPin size={18} />
                  <p>No closure records for this zone.</p>
                </div>
              )}
            </section>
            <section className="reports-section">
              <h3>Boundary provenance ({boundaryHistory.length})</h3>
              {boundaryHistory.length ? (
                <div className="contacts-list">
                  {boundaryHistory.map((event) => (
                    <article className="contact-card" key={event.id}>
                      <div className="contact-header">
                        <strong>Version {event.version}</strong>
                        <span
                          className={`status-badge status-${event.verification_state === "verified" ? "active" : "inactive"}`}
                        >
                          {event.verification_state ?? "unverified"}
                        </span>
                      </div>
                      <p>{event.change_reason ?? "Boundary change recorded"}</p>
                      <small>
                        {event.boundary_source ?? "No source recorded"} ·{" "}
                        {event.changed_via.replaceAll("_", " ")} ·{" "}
                        {new Date(event.created_at).toLocaleDateString("en-NZ")}
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <p>No versioned boundary history exists for this Zone.</p>
                </div>
              )}
            </section>
          </main>
        )}
      </div>
      {managing && selected?.location_id && (
        <OperationalPlaceManager
          locationId={selected.location_id}
          initialZoneId={selected.id}
          onClose={() => { setManaging(false); if (managerDirty) { setManagerDirty(false); setRefreshRevision((revision) => revision + 1); } }}
          onSaved={() => setManagerDirty(true)}
        />
      )}
    </div>
  );
}
