/**
 * OfficerMapPage.tsx (Officer module: 'map')
 *
 * Canonical schema: officer_gps_log, filtered to nearby colleagues on active
 * shifts in the same organization. Position feed (no map-rendering library
 * wired yet — see LiveMapPage for the same honesty note).
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface GpsPing {
  officer_id: string;
  gps_lat: number;
  gps_lng: number;
  created_at: string;
}

const OfficerMapPage: React.FC = () => {
  const { profile } = useAuth();
  const [positions, setPositions] = useState<(GpsPing & { officer_name: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: officer_gps_log, user_profiles
  useEffect(() => {
    const load = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;

      try {
        setLoading(true);
        setError(null);

        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data, error: err } = await supabase
          .from('officer_gps_log')
          .select('officer_id, gps_lat, gps_lng, created_at')
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
          const { data: profiles } = await supabase.from('user_profiles').select('id, display_name').in('id', officerIds);
          (profiles || []).forEach((p: { id: string; display_name: string | null }) => {
            names[p.id] = p.display_name || p.id;
          });
        }

        setPositions(
          Array.from(latestByOfficer.values()).map((row) => ({
            ...row,
            officer_name: names[row.officer_id] || (row.officer_id === profile.id ? 'You' : row.officer_id),
          }))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load positions');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [profile?.organizationId, profile?.id]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading team positions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Team Map</h1>
        <p className="subtitle">{positions.length} colleagues seen in the last hour</p>
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
            <p>No recent GPS positions.</p>
          </div>
        ) : (
          positions.map((p) => (
            <div key={p.officer_id} className="contact-card">
              <div className="contact-header">
                <h3>{p.officer_name}</h3>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  {p.gps_lat.toFixed(5)}, {p.gps_lng.toFixed(5)}
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

export default OfficerMapPage;
