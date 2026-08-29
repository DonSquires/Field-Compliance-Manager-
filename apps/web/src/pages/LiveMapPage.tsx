/**
 * LiveMapPage.tsx (Admin field-ops sub-area: 'live-map')
 *
 * Canonical schema: officer_gps_log — GPS heartbeat used for live map,
 * welfare, zone detection, and patrol audit. Shown here as a live position
 * feed (latest ping per officer); no map-rendering library is wired yet, so
 * this does not fabricate a map widget — it's an honest live list view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface GpsPing {
  id: string;
  officer_id: string;
  gps_lat: number;
  gps_lng: number;
  activity_type: string;
  speed_kmh: number | null;
  created_at: string;
}

interface OfficerLatest extends GpsPing {
  officer_name: string;
}

const LiveMapPage: React.FC = () => {
  const { profile } = useAuth();
  const [positions, setPositions] = useState<OfficerLatest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: officer_gps_log, user_profiles
  const loadPositions = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data, error: err } = await supabase
        .from('officer_gps_log')
        .select('id, officer_id, gps_lat, gps_lng, activity_type, speed_kmh, created_at')
        .eq('organization_id', orgId)
        .gte('created_at', since)
        .order('created_at', { ascending: false });

      if (err) throw err;

      const rows = (data as GpsPing[]) || [];
      const latestByOfficer = new Map<string, GpsPing>();
      rows.forEach((row) => {
        if (!latestByOfficer.has(row.officer_id)) latestByOfficer.set(row.officer_id, row);
      });

      const officerIds = Array.from(latestByOfficer.keys());
      const names: Record<string, string> = {};
      if (officerIds.length > 0) {
        const { data: profiles, error: profErr } = await supabase
          .from('user_profiles')
          .select('id, display_name')
          .in('id', officerIds);
        if (profErr) throw profErr;
        (profiles || []).forEach((p: { id: string; display_name: string | null }) => {
          names[p.id] = p.display_name || p.id;
        });
      }

      setPositions(
        Array.from(latestByOfficer.values()).map((row) => ({
          ...row,
          officer_name: names[row.officer_id] || row.officer_id,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load live positions');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadPositions();
    const interval = setInterval(loadPositions, 30000);
    return () => clearInterval(interval);
  }, [loadPositions]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading live positions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Live Map</h1>
        <p className="subtitle">{positions.length} officers seen in the last hour</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="contacts-list">
        {positions.length === 0 ? (
          <div className="empty-state">
            <p>No officers reporting GPS positions in the last hour.</p>
          </div>
        ) : (
          positions.map((p) => (
            <div key={p.officer_id} className="contact-card">
              <div className="contact-header">
                <h3>{p.officer_name}</h3>
                <span className="contact-type-badge">{p.activity_type}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  {p.gps_lat.toFixed(5)}, {p.gps_lng.toFixed(5)}
                  {p.speed_kmh != null ? ` · ${p.speed_kmh.toFixed(0)} km/h` : ''}
                </p>
                <p className="contact-meta">Last seen {new Date(p.created_at).toLocaleTimeString()}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LiveMapPage;
