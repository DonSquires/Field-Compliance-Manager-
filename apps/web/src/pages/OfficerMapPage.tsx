/**
 * OfficerMapPage.tsx (Officer module: 'map')
 *
 * Canonical schema: officer_gps_log, filtered to nearby colleagues on active
 * shifts in the same organization. Position feed (no map-rendering library
 * wired yet — see LiveMapPage for the same honesty note).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface GpsPing {
  officer_id: string;
  gps_lat: number;
  gps_lng: number;
  recorded_at: string;
}

const OfficerMapPage: React.FC = () => {
  const { profile } = useAuth();
  const [positions, setPositions] = useState<(GpsPing & { officer_name: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // ATLAS READS: officer_gps_log, user_profiles
  const load = useCallback(async () => {
      const orgId = profile?.organizationId;
      if (!orgId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data, error: err } = await supabase
          .from('officer_gps_log')
          .select('officer_id, gps_lat, gps_lng, recorded_at')
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
          const { data: profiles, error: profileError } = await supabase.from('user_profiles').select('id, display_name').in('id', officerIds);
          if (profileError) throw profileError;
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
        setRefreshedAt(new Date());
      } catch (err) {
        setError(err instanceof Error ? err.message : (err as { message?: string }).message ?? 'Failed to load positions');
      } finally {
        setLoading(false);
      }
    }, [profile?.id, profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

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
        <p className="subtitle">{positions.length} colleagues seen in the last hour{refreshedAt ? ` · updated ${refreshedAt.toLocaleTimeString('en-NZ')}` : ''}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'is-spinning' : ''} aria-hidden="true" /> Refresh
        </button>
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
        {positions.length === 0 && !error ? (
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
                <p className="contact-meta">Device capture {new Date(p.recorded_at).toLocaleTimeString()}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerMapPage;
