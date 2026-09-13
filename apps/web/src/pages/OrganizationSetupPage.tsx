/**
 * OrganizationSetupPage.tsx
 *
 * Canonical schema: organizations (profile fields, enforcement_workflow_mode,
 * jurisdiction_verification) + organization_modules (per-module enablement)
 * + notice_templates (read-only reference for enforcement notice config).
 * Jurisdiction geometry verification is a Bob-assisted workflow
 * (bob-jurisdiction-preview / bob_agentic_actions) not yet wired here — do
 * not fabricate that integration.
 */

import React, { useEffect, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './OrganizationSetupPage.css';

interface OrgProfile {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  enforcement_workflow_mode: string;
  jurisdiction_verification: string;
  jurisdiction_geom: GeoJSON.GeoJsonObject | null;
  status: string;
  updated_at: string;
}

interface ModuleRow {
  id: string;
  module_key: string;
  enabled: boolean;
}

interface NoticeTemplate {
  id: string;
  notice_type: string;
  version: number;
  is_active: boolean;
  authorising_act: string;
}

interface GeofenceConfigRow {
  id: string;
  config_key: string;
  config_value: number;
  zone_type: string | null;
}

// public.get_org_geofence_config()'s own comment: zone-type override -> org-wide -> these platform defaults.
const GEOFENCE_KEYS: { key: string; label: string; platformDefault: number }[] = [
  { key: 'site_provisional_radius_m', label: 'Site provisional radius (m)', platformDefault: 50 },
  { key: 'zone_provisional_radius_m', label: 'Zone provisional radius (m)', platformDefault: 100 },
  { key: 'checkpoint_radius_m', label: 'Checkpoint radius (m)', platformDefault: 5 },
];

const ENFORCEMENT_MODES = ['admin_first', 'officer_direct', 'hybrid'];
const TERRITORIAL_AUTHORITIES = ['Auckland', 'Ashburton District', 'Buller District', 'Carterton District', 'Central Hawke\'s Bay District', 'Central Otago District', 'Chatham Islands Territory', 'Christchurch City', 'Clutha District', 'Dunedin City', 'Far North District', 'Gisborne District', 'Gore District', 'Greater Wellington', 'Grey District', 'Hamilton City', 'Hastings District', 'Hauraki District', 'Hawke\'s Bay Region', 'Horowhenua District', 'Hurunui District', 'Invercargill City', 'Kaikoura District', 'Kaipara District', 'Kapiti Coast District', 'Kawerau District', 'Mackenzie District', 'Manawatu District', 'Marlborough District', 'Masterton District', 'Matamata-Piako District', 'Napier City', 'Nelson City', 'New Plymouth District', 'Northland Region', 'Opotiki District', 'Otorohanga District', 'Palmerston North City', 'Porirua City', 'Queenstown-Lakes District', 'Rangitikei District', 'Rotorua District', 'Selwyn District', 'South Taranaki District', 'South Waikato District', 'South Wairarapa District', 'Southland District', 'Stratford District', 'Tararua District', 'Tasman District', 'Taupo District', 'Tauranga City', 'Thames-Coromandel District', 'Timaru District', 'Upper Hutt City', 'Waikato District', 'Waikato Region', 'Waimakariri District', 'Waimate District', 'Waipa District', 'Wairoa District', 'Waitaki District', 'Waitomo District', 'Wellington City', 'Western Bay of Plenty District', 'Westland District', 'Whakatane District', 'Whanganui District', 'Whangarei District'];

const OrganizationSetupPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const [org, setOrg] = useState<OrgProfile | null>(null);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [templates, setTemplates] = useState<NoticeTemplate[]>([]);
  const [geofenceConfig, setGeofenceConfig] = useState<GeofenceConfigRow[]>([]);
  const [resolvedGeofenceDefaults, setResolvedGeofenceDefaults] = useState<Record<string, number>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [overrideForm, setOverrideForm] = useState({ config_key: GEOFENCE_KEYS[0].key, zone_type: '', config_value: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jurisdictionNames, setJurisdictionNames] = useState(['Nelson City']);
  const [jurisdictionPreview, setJurisdictionPreview] = useState<GeoJSON.GeoJsonObject | null>(null);
  const [jurisdictionPreviewLoading, setJurisdictionPreviewLoading] = useState(false);
  const [jurisdictionPreviewMessage, setJurisdictionPreviewMessage] = useState<string | null>(null);

  // ATLAS READS: organizations, organization_modules, notice_templates, org_geofence_config
  const loadAll = useCallback(async () => {
    const orgId = operatingOrganizationId ?? profile?.organizationId;
    if (!orgId) {
      setLoading(false);
      setError(null);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const [orgRes, modulesRes, templatesRes, geofenceRes] = await Promise.all([
        supabase
          .from('organizations')
          .select(
            'id, name, contact_email, contact_phone, billing_email, billing_address, enforcement_workflow_mode, jurisdiction_verification, jurisdiction_geom, status, updated_at'
          )
          .eq('id', orgId)
          .single(),
        supabase.from('organization_modules').select('id, module_key, enabled').eq('organization_id', orgId),
        supabase
          .from('notice_templates')
          .select('id, notice_type, version, is_active, authorising_act')
          .eq('organization_id', orgId),
        supabase
          .from('org_geofence_config')
          .select('id, config_key, config_value, zone_type')
          .eq('organization_id', orgId),
      ]);

      if (orgRes.error) throw orgRes.error;
      if (modulesRes.error) throw modulesRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (geofenceRes.error) throw geofenceRes.error;

      setOrg(orgRes.data as OrgProfile);
      setModules((modulesRes.data as ModuleRow[]) || []);
      setTemplates((templatesRes.data as NoticeTemplate[]) || []);
      setGeofenceConfig((geofenceRes.data as GeofenceConfigRow[]) || []);
      const resolvedEntries = await Promise.all(GEOFENCE_KEYS.map(async (key) => {
        const { data, error: resolutionError } = await supabase.rpc('get_org_geofence_config', {
          p_org_id: orgId,
          p_config_key: key.key,
          p_zone_type: null,
          p_default: key.platformDefault,
        });
        if (resolutionError) throw resolutionError;
        return [key.key, Number(data)] as const;
      }));
      setResolvedGeofenceDefaults(Object.fromEntries(resolvedEntries));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organisation setup');
    } finally {
      setLoading(false);
    }
  }, [operatingOrganizationId, profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;

    try {
      setSaving(true);
      setError(null);

      const { data, error } = await supabase.rpc('update_operating_branch_profile', {
        p_operating_organization_id: org.id,
        p_expected_updated_at: org.updated_at,
        p_contact_email: org.contact_email,
        p_contact_phone: org.contact_phone,
        p_billing_email: org.billing_email,
        p_billing_address: org.billing_address,
        p_enforcement_workflow_mode: org.enforcement_workflow_mode,
      });

      if (error) throw error;
      if (data) setOrg(data as OrgProfile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save organisation profile');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleModule = async (mod: ModuleRow) => {
    try {
      const { error } = await supabase.rpc('set_operating_branch_module', { p_operating_organization_id: org?.id, p_module_key: mod.module_key, p_enabled: !mod.enabled });

      if (error) throw error;
      setModules(modules.map((m) => (m.id === mod.id ? { ...m, enabled: !m.enabled } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update module');
    }
  };

  // Manual find-then-update/insert rather than upsert(onConflict): the
  // org_geofence_config unique constraint is (organization_id, config_key,
  // zone_type), but Postgres treats every NULL zone_type as distinct from
  // every other NULL for uniqueness purposes -- an upsert would silently
  // insert a duplicate org-wide row instead of updating the existing one.
  const saveGeofenceValue = async (configKey: string, zoneType: string | null, value: number) => {
    if (!org || Number.isNaN(value)) return;
    try {
      setSavingKey(`${configKey}:${zoneType ?? ''}`);
      setError(null);

      const { data, error } = await supabase.rpc('manage_operating_branch_geofence_config', { p_operating_organization_id: org.id, p_action: 'set', p_config_id: null, p_config_key: configKey, p_zone_type: zoneType, p_config_value: value });
      if (error) throw error;
      const saved = data as GeofenceConfigRow;
      setGeofenceConfig((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save geofence config');
    } finally {
      setSavingKey(null);
    }
  };

  const handleAddOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(overrideForm.config_value);
    if (!overrideForm.zone_type.trim() || Number.isNaN(value)) return;
    await saveGeofenceValue(overrideForm.config_key, overrideForm.zone_type.trim(), value);
    setOverrideForm({ config_key: GEOFENCE_KEYS[0].key, zone_type: '', config_value: '' });
  };

  const handleDeleteOverride = async (id: string) => {
    try {
      setError(null);
      if (!org) return;
      const { error } = await supabase.rpc('manage_operating_branch_geofence_config', { p_operating_organization_id: org.id, p_action: 'remove', p_config_id: id, p_config_key: null, p_zone_type: null, p_config_value: null });
      if (error) throw error;
      setGeofenceConfig(geofenceConfig.filter((g) => g.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove override');
    }
  };

  const previewJurisdiction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (jurisdictionNames.length === 0) return;
    setJurisdictionPreviewLoading(true);
    setJurisdictionPreviewMessage(null);
    setJurisdictionPreview(null);
    const { data, error: previewError } = await supabase.functions.invoke('bob-jurisdiction-preview', { body: { district_names: jurisdictionNames } });
    if (previewError || !data?.results?.length || data.results.some((result: { matched: boolean }) => !result.matched)) {
      const unmatched = (data?.unmatched ?? jurisdictionNames).join(', ');
      setJurisdictionPreviewMessage(previewError?.message ?? `No verified Territorial Authority boundary matched: ${unmatched}.`);
    } else {
      setJurisdictionPreview({ type: 'FeatureCollection', features: data.results.map((result: { geometry: GeoJSON.GeoJsonObject; name: string }) => ({ type: 'Feature', properties: { name: result.name }, geometry: result.geometry })) } as GeoJSON.GeoJsonObject);
      setJurisdictionPreviewMessage(`Read-only boundary preview loaded for ${jurisdictionNames.join(', ')}. Nothing has been saved.`);
    }
    setJurisdictionPreviewLoading(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading organisation setup...</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <p>Organisation profile not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Organization Setup</h1>
        <p className="subtitle">{org.name}</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <section className="reports-section">
        <h2>Profile</h2>
        <form className="settings-form" onSubmit={handleSaveProfile}>
          <div className="form-row">
            <div className="form-group">
              <label>Contact Email</label>
              <input
                type="email"
                value={org.contact_email || ''}
                onChange={(e) => setOrg({ ...org, contact_email: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Contact Phone</label>
              <input
                type="tel"
                value={org.contact_phone || ''}
                onChange={(e) => setOrg({ ...org, contact_phone: e.target.value })}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Billing Email</label>
              <input
                type="email"
                value={org.billing_email || ''}
                onChange={(e) => setOrg({ ...org, billing_email: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Billing Address</label>
              <input
                type="text"
                value={org.billing_address || ''}
                onChange={(e) => setOrg({ ...org, billing_address: e.target.value })}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Enforcement Workflow Mode</label>
            <select
              value={org.enforcement_workflow_mode}
              onChange={(e) => setOrg({ ...org, enforcement_workflow_mode: e.target.value })}
            >
              {ENFORCEMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Jurisdiction Verification</label>
            <p className="contact-meta">
              {org.jurisdiction_verification === 'verified' ? '✓ Verified' : 'Unverified'} (managed via Bob
              jurisdiction review, not editable here)
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Profile'}
          </button>
        </form>
      </section>

      <section className="reports-section organization-jurisdiction-section">
        <h2>Branch Jurisdiction Map</h2>
        <p className="contact-meta">Resolve the branch Territorial Authority boundary before Bob proposes it for approval. This preview is read-only; it does not write or verify the jurisdiction.</p>
        <form className="settings-form organization-jurisdiction-form" onSubmit={previewJurisdiction}>
          <div className="form-row"><fieldset className="jurisdiction-checkboxes"><legend>Territorial Authorities</legend>{TERRITORIAL_AUTHORITIES.map((authority) => <label key={authority}><input type="checkbox" checked={jurisdictionNames.includes(authority)} onChange={(event) => setJurisdictionNames((current) => event.target.checked ? [...current, authority] : current.filter((selected) => selected !== authority))} /> <span>{authority}</span></label>)}</fieldset><button type="submit" className="btn btn-secondary" disabled={jurisdictionPreviewLoading || jurisdictionNames.length === 0}>{jurisdictionPreviewLoading ? 'Resolving…' : 'Preview boundaries'}</button></div>
        </form>
        {jurisdictionPreviewMessage && <div className={`organization-jurisdiction-message ${jurisdictionPreview ? 'is-success' : 'is-error'}`} role="status">{jurisdictionPreviewMessage}</div>}
        <JurisdictionPreviewMap geometry={jurisdictionPreview ?? org.jurisdiction_geom} label={jurisdictionNames.join(', ')} />
        <p className="contact-meta">Next step: Bob submits the resolved boundary to the Approvals page. A human must approve it and then visually verify it before branch routing uses it.</p>
      </section>

      <section className="reports-section">
        <h2>Modules ({modules.length})</h2>
        <div className="contacts-list">
          {modules.length === 0 ? (
            <div className="empty-state">
              <p>No module configuration for this organisation.</p>
            </div>
          ) : (
            modules.map((mod) => (
              <div key={mod.id} className="contact-card">
                <div className="contact-header">
                  <h3>{mod.module_key}</h3>
                  <button
                    className={`btn btn-sm ${mod.enabled ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleToggleModule(mod)}
                  >
                    {mod.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Notice Templates ({templates.length})</h2>
        <div className="contacts-list">
          {templates.length === 0 ? (
            <div className="empty-state">
              <p>No notice templates configured.</p>
            </div>
          ) : (
            templates.map((t) => (
              <div key={t.id} className="contact-card">
                <div className="contact-header">
                  <h3>{t.notice_type}</h3>
                  <span className={`status-badge status-${t.is_active ? 'active' : 'inactive'}`}>
                    v{t.version} · {t.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <p className="contact-meta">{t.authorising_act}</p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Geofence Configuration</h2>
        <p className="contact-meta">
          Provisional detection radii, read by get_org_geofence_config() with zone-type override → org-wide → platform
          default fallback.
        </p>
        <div className="contacts-list" style={{ marginTop: '8px' }}>
          {GEOFENCE_KEYS.map((k) => {
            const existing = geofenceConfig.find((g) => g.config_key === k.key && g.zone_type === null);
            const resolvedValue = resolvedGeofenceDefaults[k.key] ?? existing?.config_value ?? k.platformDefault;
            return (
              <div key={k.key} className="contact-card">
                <div className="contact-header">
                  <h3>{k.label}</h3>
                </div>
                <div className="contact-details" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="number"
                    min={0}
                    defaultValue={resolvedValue}
                    style={{ width: '100px' }}
                    onBlur={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isNaN(value) && value !== (existing?.config_value ?? k.platformDefault)) {
                        saveGeofenceValue(k.key, null, value);
                      }
                    }}
                  />
                  <span className="contact-meta">
                    {existing ? 'org-wide override' : `resolved fallback (${resolvedValue})`}
                    {savingKey === `${k.key}:` ? ' · saving…' : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <h3 style={{ marginTop: '16px', fontSize: '14px' }}>Per-Zone-Type Overrides</h3>
        <div className="contacts-list" style={{ marginTop: '8px' }}>
          {geofenceConfig.filter((g) => g.zone_type !== null).length === 0 ? (
            <div className="empty-state">
              <p>No zone-type-specific overrides.</p>
            </div>
          ) : (
            geofenceConfig
              .filter((g) => g.zone_type !== null)
              .map((g) => (
                <div key={g.id} className="contact-card">
                  <div className="contact-header">
                    <h3>
                      {g.config_key} · {g.zone_type}
                    </h3>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDeleteOverride(g.id)}>
                      Remove
                    </button>
                  </div>
                  <p className="contact-meta">{g.config_value}m</p>
                </div>
              ))
          )}
        </div>

        <form className="settings-form" onSubmit={handleAddOverride} style={{ marginTop: '12px' }}>
          <div className="form-row">
            <div className="form-group">
              <label>Config Key</label>
              <select
                value={overrideForm.config_key}
                onChange={(e) => setOverrideForm({ ...overrideForm, config_key: e.target.value })}
              >
                {GEOFENCE_KEYS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Zone Type</label>
              <input
                type="text"
                required
                placeholder="e.g. freedom_camping"
                value={overrideForm.zone_type}
                onChange={(e) => setOverrideForm({ ...overrideForm, zone_type: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Value (m)</label>
              <input
                type="number"
                min={0}
                required
                value={overrideForm.config_value}
                onChange={(e) => setOverrideForm({ ...overrideForm, config_value: e.target.value })}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-secondary btn-sm">
            Add Override
          </button>
        </form>
      </section>
    </div>
  );
};

function JurisdictionPreviewMap({ geometry, label }: { geometry: GeoJSON.GeoJsonObject | null; label: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!containerRef.current || !geometry) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([-41.27, 173.28], 9);
    const linzTile = (layer: 'topographic' | 'aerial') => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/linz-map-tile?layer=${layer}&z={z}&x={x}&y={y}`;
    const topographic = L.tileLayer(linzTile('topographic'), { attribution: '&copy; LINZ | CC BY 4.0', maxZoom: 18 }).addTo(map);
    const aerial = L.tileLayer(linzTile('aerial'), { attribution: '&copy; LINZ | CC BY 4.0', maxZoom: 18 });
    L.control.layers({ 'LINZ topographic': topographic, 'LINZ aerial': aerial }, undefined, { collapsed: false }).addTo(map);
    const layer = L.geoJSON(geometry, { style: { color: '#14c8d4', weight: 2, fillColor: '#14c8d4', fillOpacity: 0.16 } }).bindTooltip(label).addTo(map);
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.08));
    const timer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => { window.clearTimeout(timer); map.remove(); };
  }, [geometry, label]);
  return geometry ? <div className="organization-jurisdiction-map" ref={containerRef} aria-label={`${label} jurisdiction preview`} /> : <div className="organization-jurisdiction-map-empty">Enter a Territorial Authority and preview its boundary here.</div>;
}

export default OrganizationSetupPage;
