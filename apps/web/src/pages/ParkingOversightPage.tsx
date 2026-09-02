import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, MapPinned, RefreshCw, Scale } from 'lucide-react';
import { imageFileToBase64 } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ParkingZone {
  id: string;
  name: string;
  configuration_version: number;
  parking_time_limit_minutes: number | null;
  parking_disabled_multiplier: number;
  parking_limit_source: string | null;
  parking_signage_photo_url: string | null;
  parking_limit_set_at: string | null;
}

interface ChalkRecord {
  id: string;
  plate: string;
  officer_name: string | null;
  location_name: string | null;
  status: string;
  chalked_at: string;
  return_by: string;
  effective_time_limit_minutes: number | null;
  movement_detected: boolean | null;
  rego_status: string | null;
  wof_status: string | null;
  cof_status: string | null;
  infringement_number: string | null;
  zone_id: string | null;
}

const ParkingOversightPage: React.FC = () => {
  const [zones, setZones] = useState<ParkingZone[]>([]);
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [rule, setRule] = useState({ timeLimit: '60', disabledMultiplier: '2', source: 'manual' });
  const [signageImageBase64, setSignageImageBase64] = useState<string>();
  const [signageFileName, setSignageFileName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [zoneResult, recordResult] = await Promise.all([
        supabase.from('location_zones').select('id, name, configuration_version, parking_time_limit_minutes, parking_disabled_multiplier, parking_limit_source, parking_signage_photo_url, parking_limit_set_at').eq('zone_type', 'parking').eq('module_key', 'parking_enforcement').eq('is_active', true).order('name'),
        supabase.from('parking_chalk_records').select('id, plate, officer_name, location_name, status, chalked_at, return_by, effective_time_limit_minutes, movement_detected, rego_status, wof_status, cof_status, infringement_number, zone_id').order('chalked_at', { ascending: false }).limit(100),
      ]);
      if (zoneResult.error) throw zoneResult.error;
      if (recordResult.error) throw recordResult.error;
      const nextZones = (zoneResult.data as ParkingZone[]) ?? [];
      setZones(nextZones);
      setRecords((recordResult.data as ChalkRecord[]) ?? []);
      setZoneId((current) => nextZones.some((zone) => zone.id === current) ? current : nextZones[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Parking oversight could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const selectedZone = zones.find((zone) => zone.id === zoneId) ?? null;
  useEffect(() => {
    if (!selectedZone) return;
    setRule({
      timeLimit: selectedZone.parking_time_limit_minutes?.toString() ?? '60',
      disabledMultiplier: selectedZone.parking_disabled_multiplier?.toString() ?? '2',
      source: selectedZone.parking_limit_source ?? 'manual',
    });
    setSignageImageBase64(undefined);
    setSignageFileName('');
  }, [selectedZone]);

  const handleSignage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      setSignageImageBase64(await imageFileToBase64(file));
      setSignageFileName(file.name);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : 'Signage image could not be prepared.');
    }
  };

  const saveRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedZone) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('update-parking-zone-rule', {
        body: {
          zone_id: selectedZone.id,
          expected_version: selectedZone.configuration_version,
          time_limit_minutes: Number(rule.timeLimit),
          disabled_multiplier: Number(rule.disabledMultiplier),
          limit_source: rule.source,
          signage_image_base64: signageImageBase64,
        },
      });
      if (invokeError) throw invokeError;
      if (!data?.success) throw new Error(data?.detail ?? 'Parking rule update was not confirmed.');
      setNotice(`${selectedZone.name} rule provenance saved.`);
      await loadWorkspace();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Parking rule could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container">
      <header className="page-header"><h1>Parking</h1><p className="subtitle">Zone rule governance and field evidence oversight</p></header>
      {error && <div className="alert alert-error" role="alert"><AlertTriangle size={18} /> {error}</div>}
      {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={18} /> {notice}</div>}

      <section className="parking-admin-grid">
        <form className="assessment-form parking-rule-form" onSubmit={saveRule}>
          <div className="form-section-header"><Scale size={20} /><div><h2>Enforcement rule</h2><p>Record the rule officers will apply and its authority.</p></div></div>
          <div className="form-group"><label htmlFor="parking-admin-zone">Parking zone</label><select id="parking-admin-zone" value={zoneId} onChange={(event) => setZoneId(event.target.value)} disabled={loading}>{zones.length === 0 && <option value="">No active Parking zones</option>}{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></div>
          <div className="form-grid form-grid-2"><div className="form-group"><label htmlFor="parking-limit">Posted limit (minutes)</label><input id="parking-limit" type="number" min="1" max="1440" required value={rule.timeLimit} onChange={(event) => setRule({ ...rule, timeLimit: event.target.value })} /></div><div className="form-group"><label htmlFor="parking-disabled">Disabled-bay multiplier</label><input id="parking-disabled" type="number" min="1" max="4" step="0.25" required value={rule.disabledMultiplier} onChange={(event) => setRule({ ...rule, disabledMultiplier: event.target.value })} /></div></div>
          <div className="form-group"><label htmlFor="parking-source">Rule source</label><select id="parking-source" value={rule.source} onChange={(event) => setRule({ ...rule, source: event.target.value })}><option value="manual">Administrator verified</option><option value="bob_signage">Signage extracted and human approved</option><option value="rfp_seed">Service agreement or RFP</option></select></div>
          <label className="parking-signage-control"><Camera size={19} /><span><strong>{signageFileName || (selectedZone?.parking_signage_photo_url ? 'Replace signage evidence' : 'Attach signage evidence')}</strong><small>Private JPEG evidence for the posted rule</small></span><input type="file" accept="image/*" capture="environment" onChange={handleSignage} /></label>
          {selectedZone && <div className="parking-provenance"><MapPinned size={17} /><span>Version {selectedZone.configuration_version} · {selectedZone.parking_limit_source?.replaceAll('_', ' ') || 'no source recorded'}{selectedZone.parking_limit_set_at ? ` · set ${new Date(selectedZone.parking_limit_set_at).toLocaleString()}` : ''}</span></div>}
          <button type="submit" className="btn btn-primary btn-block" disabled={!selectedZone || saving}>{saving ? 'Saving governed rule...' : 'Save Parking rule'}</button>
        </form>

        <div className="parking-ops-summary"><div><span>Active zones</span><strong>{zones.length}</strong></div><div><span>Open observations</span><strong>{records.filter((record) => record.status === 'active').length}</strong></div><div><span>Infringements</span><strong>{records.filter((record) => record.infringement_number).length}</strong></div></div>
      </section>

      <section className="parking-history">
        <div className="section-heading"><div><h2>Recent field evidence</h2><p>Applied rule, vehicle compliance, movement, and enforcement outcome.</p></div><button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw size={15} /> Refresh</button></div>
        <div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Plate</th><th>Officer / place</th><th>Observed</th><th>Applied rule</th><th>Vehicle checks</th><th>Outcome</th></tr></thead><tbody>{records.length === 0 ? <tr><td colSpan={6} className="text-center">{loading ? 'Loading evidence...' : 'No Parking evidence recorded'}</td></tr> : records.map((record) => <tr key={record.id}><td><strong>{record.plate}</strong></td><td>{record.officer_name || 'Unknown officer'}<br /><small>{record.location_name || zones.find((zone) => zone.id === record.zone_id)?.name || 'Configured area'}</small></td><td>{new Date(record.chalked_at).toLocaleString()}<br /><small>Return {new Date(record.return_by).toLocaleString()}</small></td><td>{record.effective_time_limit_minutes ?? '—'} min</td><td>Rego {record.rego_status ?? 'unknown'}<br /><small>WoF {record.wof_status ?? 'unknown'} · CoF {record.cof_status ?? 'unknown'}</small></td><td><span className={`status-badge status-${record.status}`}>{record.status.replaceAll('_', ' ')}</span>{record.movement_detected !== null && <small className="parking-outcome-detail">{record.movement_detected ? 'Vehicle moved' : 'Vehicle stationary'}</small>}{record.infringement_number && <strong className="parking-outcome-detail">{record.infringement_number}</strong>}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
};

export default ParkingOversightPage;