import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Image, LandPlot, MapPin } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import {
  LocationHouseMap,
  type HouseMapSite,
  type HouseMapZone,
} from "../components/LocationHouseMap";
import { OperationalPlaceManager } from "../components/OperationalPlaceManager";
import { ZoneScheduleEditor } from "../components/ZoneScheduleEditor";
import { parseZoneSchedule, zoneScheduleWords } from "../lib/zoneSchedule";
import "./PageStyles.css";
import "./GeographyPages.css";
import "./ZoneDetailPage.css";

interface ZoneRow extends HouseMapZone {
  organization_id: string;
  location_id: string | null;
  zone_type: string;
  module_key: string;
  rule_type: string;
  is_active: boolean;
  active_schedule: Record<string, unknown> | null;
  onsite_profile: string;
  enforcement_workflow_override: string | null;
  /** The house address (zones carry no address of their own). */
  address: string | null;
  bylaw_clause: string | null;
  bylaw_source_url: string | null;
  nightly_limit_consecutive: number | null;
  nightly_limit_monthly: number | null;
  scv_required: boolean;
  parking_time_limit_minutes: number | null;
  parking_disabled_multiplier: number;
  parking_signage_photo_url: string | null;
  parking_limit_source: string | null;
  parking_limit_set_at: string | null;
  configuration_version: number;
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
interface ActivityEventRow {
  id: string;
  event_type: string;
  module_key: string | null;
  occurred_at: string;
  status: string | null;
  source: string | null;
  payload: Record<string, unknown> | null;
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
  const [recentActivity, setRecentActivity] = useState<ActivityEventRow[]>([]);
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
  const [complianceForm, setComplianceForm] = useState({ nightly_limit_consecutive: '', nightly_limit_monthly: '', scv_required: false });
  const [savingCompliance, setSavingCompliance] = useState(false);
  const [parkingForm, setParkingForm] = useState({ time_limit_minutes: '', disabled_multiplier: '2' });
  const [parkingSignageFile, setParkingSignageFile] = useState<File | null>(null);
  const [parkingPendingPath, setParkingPendingPath] = useState<string | null>(null);
  const [parkingRequestId, setParkingRequestId] = useState(() => crypto.randomUUID());
  const [parkingConfirmed, setParkingConfirmed] = useState(false);
  const [parkingSaving, setParkingSaving] = useState(false);
  const [parkingSuccess, setParkingSuccess] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!profile?.organizationId) {
        setError('Organisation access could not be confirmed. Zone data is unavailable.');
        setLoading(false);
        return;
      }
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
    const [closuresRes, historyRes, activityRes] = await Promise.all([
      supabase
        .from("zone_closures")
        .select("id,closure_type,status,effective_from,effective_to,reason")
        .eq("zone_id", zone.id)
        .order("effective_from", { ascending: false }),
      supabase.rpc("get_boundary_history", {
        p_entity_type: "location_zone",
        p_entity_id: zone.id,
      }),
      supabase
        .from("location_events")
        .select("id,event_type,module_key,occurred_at,status,source,payload")
        .eq("zone_id", zone.id)
        .order("occurred_at", { ascending: false })
        .limit(25),
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
      availableSites.filter((site) => site.location_id === zone.location_id),
    );
    setClosures((closuresRes.data as ClosureRow[]) ?? []);
    setBoundaryHistory((historyRes.data as BoundaryEvent[]) ?? []);
    setRecentActivity((activityRes.data as ActivityEventRow[]) ?? []);
  };

  const selectZone = (zone: ZoneRow) => {
    setSelected(zone);
    navigate(`/admin/zones?zone=${zone.id}`, { replace: true });
    void loadContext(zone);
  };

  useEffect(() => {
    setComplianceForm({
      nightly_limit_consecutive: selected?.nightly_limit_consecutive != null ? String(selected.nightly_limit_consecutive) : '',
      nightly_limit_monthly: selected?.nightly_limit_monthly != null ? String(selected.nightly_limit_monthly) : '',
      scv_required: selected?.scv_required ?? false,
    });
    setParkingForm({
      time_limit_minutes: selected?.parking_time_limit_minutes != null ? String(selected.parking_time_limit_minutes) : '',
      disabled_multiplier: selected?.parking_disabled_multiplier != null ? String(selected.parking_disabled_multiplier) : '2',
    });
    setParkingSignageFile(null);
    setParkingPendingPath(null);
    setParkingRequestId(crypto.randomUUID());
    setParkingConfirmed(false);
    setParkingSuccess(null);
  }, [selected?.id]);

  const handleSaveCompliance = async () => {
    if (!selected || savingCompliance) return;
    if (!selected.location_id) {
      setError("Compliance limits can only be saved for zones linked to an operational location.");
      return;
    }
    setSavingCompliance(true);
    setError(null);
    const nightlyLimitConsecutive = complianceForm.nightly_limit_consecutive.trim() ? Number(complianceForm.nightly_limit_consecutive) : null;
    const nightlyLimitMonthly = complianceForm.nightly_limit_monthly.trim() ? Number(complianceForm.nightly_limit_monthly) : null;
    // ATLAS WRITES: location_zones via manage_crm_zone
    const { data, error: updateError } = await supabase.rpc('manage_crm_zone', {
      p_action: 'update',
      p_zone_id: selected.id,
      p_location_id: selected.location_id,
      p_expected_version: selected.configuration_version,
      p_name: selected.name,
      p_zone_type: selected.zone_type,
      p_module_key: selected.module_key,
      p_rule_type: selected.rule_type,
      p_is_active: selected.is_active,
      p_nightly_limit_consecutive: nightlyLimitConsecutive,
      p_nightly_limit_monthly: nightlyLimitMonthly,
      p_scv_required: complianceForm.scv_required,
      p_enforcement_workflow_override: selected.enforcement_workflow_override,
    });
    if (updateError) {
      setError(updateError.message);
    } else {
      const saved = data as Partial<ZoneRow> | null;
      const updated = { ...selected, ...saved, nightly_limit_consecutive: nightlyLimitConsecutive, nightly_limit_monthly: nightlyLimitMonthly, scv_required: complianceForm.scv_required };
      setSelected(updated);
      setZones(zones.map((z) => (z.id === updated.id ? updated : z)));
    }
    setSavingCompliance(false);
  };

  const changeParkingDraft = (next: Partial<typeof parkingForm>) => {
    setParkingForm((current) => ({ ...current, ...next }));
    setParkingRequestId(crypto.randomUUID());
    setParkingPendingPath(null);
    setParkingSuccess(null);
  };

  const keepCurrentParkingRule = () => {
    if (!selected) return;
    setParkingForm({
      time_limit_minutes: selected.parking_time_limit_minutes != null ? String(selected.parking_time_limit_minutes) : '',
      disabled_multiplier: String(selected.parking_disabled_multiplier ?? 2),
    });
    setParkingSignageFile(null);
    setParkingPendingPath(null);
    setParkingRequestId(crypto.randomUUID());
    setParkingConfirmed(false);
    setParkingSuccess(null);
    setError(null);
  };

  const handleSaveParkingRule = async () => {
    if (!selected || parkingSaving) return;
    const timeLimit = Number(parkingForm.time_limit_minutes);
    const disabledMultiplier = Number(parkingForm.disabled_multiplier);
    if (!Number.isInteger(timeLimit) || timeLimit < 1 || timeLimit > 1440) {
      setError('Parking time limit must be a whole number between 1 and 1440 minutes.');
      return;
    }
    if (!Number.isFinite(disabledMultiplier) || disabledMultiplier < 1 || disabledMultiplier > 4) {
      setError('Disabled-bay multiplier must be between 1 and 4.');
      return;
    }
    if (!selected.parking_signage_photo_url && !parkingSignageFile && !parkingPendingPath) {
      setError('Add a photograph of the posted Parking sign before saving this rule.');
      return;
    }
    if (!parkingConfirmed) {
      setError('Confirm that the limit matches the photographed sign before saving.');
      return;
    }
    const supportedSignageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (parkingSignageFile && (!supportedSignageTypes.includes(parkingSignageFile.type) || parkingSignageFile.size > 15 * 1024 * 1024)) {
      setError('Parking signage evidence must be a JPEG, PNG, or WebP image no larger than 15 MB.');
      return;
    }

    setParkingSaving(true);
    setParkingSuccess(null);
    setError(null);
    let signagePath = parkingPendingPath ?? selected.parking_signage_photo_url;
    if (parkingSignageFile && !parkingPendingPath) {
      const extension = parkingSignageFile.type === 'image/png'
        ? 'png'
        : parkingSignageFile.type === 'image/webp'
          ? 'webp'
          : 'jpg';
      signagePath = `org/${selected.organization_id}/parking-signage/${selected.id}/${parkingRequestId}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from('scans')
        .upload(signagePath, parkingSignageFile, {
          contentType: parkingSignageFile.type,
          upsert: false,
        });
      if (uploadError) {
        setError(`Parking signage evidence could not be uploaded: ${uploadError.message}`);
        setParkingSaving(false);
        return;
      }
      setParkingPendingPath(signagePath);
    }

    // ATLAS WRITES: location_zones via manage_parking_zone_rule
    const { data, error: saveError } = await supabase.rpc('manage_parking_zone_rule', {
      p_client_request_id: parkingRequestId,
      p_zone_id: selected.id,
      p_expected_version: selected.configuration_version,
      p_time_limit_minutes: timeLimit,
      p_disabled_multiplier: disabledMultiplier,
      p_limit_source: 'manual',
      p_signage_photo_path: signagePath,
    });
    if (saveError) {
      setError(`Parking rule was not saved: ${saveError.message}. Retry without changing the values so the same request can be checked safely.`);
      setParkingSaving(false);
      return;
    }

    const saved = data as Partial<ZoneRow>;
    const updated = { ...selected, ...saved };
    setSelected(updated);
    setZones((current) => current.map((zone) => (zone.id === updated.id ? updated : zone)));
    setParkingSignageFile(null);
    setParkingPendingPath(null);
    setParkingConfirmed(false);
    setParkingRequestId(crypto.randomUUID());
    setParkingSuccess(`Saved P${updated.parking_time_limit_minutes} with photographed signage evidence. Future Parking scans use zone version ${updated.configuration_version}.`);
    setParkingSaving(false);
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
            onClick={() => navigate(selected ? `/admin/sites?place=location_zone:${selected.id}` : "/admin/sites")}
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
              editableEntity={{
                type: "location_zone",
                id: selected.id,
                organizationId: selected.organization_id,
                zoneType: selected.zone_type,
                centerLat: selected.center_point?.coordinates?.[1] ?? null,
                centerLng: selected.center_point?.coordinates?.[0] ?? null,
                onSaved: () => setRefreshRevision((revision) => revision + 1),
              }}
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
                <strong>{zoneScheduleWords(parseZoneSchedule(selected.active_schedule))}</strong>
              </article>
            </section>
            <ZoneScheduleEditor
              zone={selected}
              moduleLabel={selected.module_key.replaceAll("_", " ")}
              onSaved={(saved) => {
                const updated = { ...selected, active_schedule: saved.active_schedule, configuration_version: saved.configuration_version };
                setSelected(updated);
                setZones((current) => current.map((zone) => (zone.id === updated.id ? updated : zone)));
              }}
            />
            {selected.module_key === 'freedom_camping' && (
            <section className="reports-section">
              <h3>Compliance limits</h3>
              <div className="form-group">
                <label>Consecutive-night limit</label>
                <input
                  type="number"
                  min={0}
                  value={complianceForm.nightly_limit_consecutive}
                  onChange={(e) => setComplianceForm({ ...complianceForm, nightly_limit_consecutive: e.target.value })}
                  placeholder="No limit"
                />
              </div>
              <div className="form-group">
                <label>Monthly-night limit</label>
                <input
                  type="number"
                  min={0}
                  value={complianceForm.nightly_limit_monthly}
                  onChange={(e) => setComplianceForm({ ...complianceForm, nightly_limit_monthly: e.target.value })}
                  placeholder="No limit"
                />
              </div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={complianceForm.scv_required}
                    onChange={(e) => setComplianceForm({ ...complianceForm, scv_required: e.target.checked })}
                  />{' '}
                  Self-contained vehicle (SCV) certification required
                </label>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveCompliance()} disabled={savingCompliance}>
                {savingCompliance ? 'Saving…' : 'Save Compliance Limits'}
              </button>
            </section>
            )}
            {selected.module_key === 'parking_enforcement' && selected.zone_type === 'parking' && (
              <section className="reports-section parking-rule-workspace" aria-labelledby="parking-rule-heading">
                <div className="parking-rule-heading">
                  <div>
                    <h3 id="parking-rule-heading">Posted Parking rule</h3>
                    <p>
                      Configure the photographed sign before officers use this zone. Future scans resolve this rule;
                      existing chalk and notice evidence remains unchanged.
                    </p>
                  </div>
                  <span className={`status-badge status-${selected.parking_time_limit_minutes ? 'active' : 'inactive'}`}>
                    {selected.parking_time_limit_minutes ? `P${selected.parking_time_limit_minutes}` : 'Configuration required'}
                  </span>
                </div>
                <div className="parking-rule-fields">
                  <div className="form-group">
                    <label htmlFor="parking-time-limit">Posted limit in minutes</label>
                    <input
                      id="parking-time-limit"
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      value={parkingForm.time_limit_minutes}
                      onChange={(event) => changeParkingDraft({ time_limit_minutes: event.target.value })}
                      placeholder="For example, 60"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="parking-disabled-multiplier">Disabled-bay multiplier</label>
                    <input
                      id="parking-disabled-multiplier"
                      type="number"
                      min={1}
                      max={4}
                      step={0.25}
                      value={parkingForm.disabled_multiplier}
                      onChange={(event) => changeParkingDraft({ disabled_multiplier: event.target.value })}
                    />
                  </div>
                </div>
                <div className="parking-signage-evidence">
                  <Image size={18} aria-hidden="true" />
                  <div>
                    <label htmlFor="parking-signage-photo">
                      {selected.parking_signage_photo_url ? 'Replace photographed sign' : 'Photograph of posted sign'}
                    </label>
                    <input
                      id="parking-signage-photo"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => {
                        setParkingSignageFile(event.target.files?.[0] ?? null);
                        setParkingPendingPath(null);
                        setParkingRequestId(crypto.randomUUID());
                        setParkingSuccess(null);
                      }}
                    />
                    <small>
                      {parkingPendingPath
                        ? 'The private evidence upload is ready; retrying will reuse it.'
                        : selected.parking_signage_photo_url
                          ? `Current source: ${selected.parking_limit_source?.replaceAll('_', ' ') ?? 'recorded signage'}`
                          : 'Required. Image files up to 15 MB are retained in the private scans bucket.'}
                    </small>
                  </div>
                </div>
                <label className="parking-rule-confirmation">
                  <input
                    type="checkbox"
                    checked={parkingConfirmed}
                    onChange={(event) => setParkingConfirmed(event.target.checked)}
                  />
                  I checked the entered limit and disabled-bay multiplier against the photographed sign.
                </label>
                {parkingSuccess && (
                  <div className="parking-rule-success" role="status">
                    <CheckCircle2 size={17} aria-hidden="true" />
                    {parkingSuccess}
                  </div>
                )}
                <div className="parking-rule-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveParkingRule()}
                    disabled={parkingSaving}
                  >
                    {parkingSaving ? 'Saving photographed rule…' : 'Save Parking rule'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={keepCurrentParkingRule}
                    disabled={parkingSaving}
                  >
                    Keep current rule
                  </button>
                </div>
              </section>
            )}
            {(selected.bylaw_clause || selected.bylaw_source_url) && (
              <section className="reports-section">
                <h3>Legal authority</h3>
                <p>{selected.bylaw_clause ?? "Clause not recorded"}</p>
                {selected.bylaw_source_url && (
                  <a
                    href={selected.bylaw_source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source bylaw
                  </a>
                )}
              </section>
            )}
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
            <section className="reports-section">
              <h3>Recent activity ({recentActivity.length})</h3>
              {recentActivity.length ? (
                <div className="contacts-list">
                  {recentActivity.map((event) => {
                    const payload = event.payload ?? {};
                    const summary =
                      (typeof payload.description === "string" && payload.description) ||
                      (typeof payload.comments === "string" && payload.comments) ||
                      (typeof payload.patroller === "string" && `Patroller: ${payload.patroller}`) ||
                      "No further detail recorded";
                    return (
                      <article className="contact-card" key={event.id}>
                        <div className="contact-header">
                          <strong>{event.event_type.replaceAll("_", " ")}</strong>
                          {event.status && (
                            <span className="status-badge status-active">{event.status}</span>
                          )}
                        </div>
                        <p>{summary}</p>
                        <small>
                          {event.module_key ?? "module not recorded"} ·{" "}
                          {event.source ?? "source not recorded"} ·{" "}
                          {new Date(event.occurred_at).toLocaleString("en-NZ")}
                        </small>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">
                  <MapPin size={18} />
                  <p>No recorded activity for this zone yet.</p>
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
