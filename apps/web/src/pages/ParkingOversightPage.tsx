/**
 * ParkingOversightPage.tsx (Admin field-ops sub-area: 'parking')
 *
 * Canonical schema: parking_chalk_records, org-wide oversight — distinct
 * from OfficerParkingPage which is the officer's own chalk/return workflow.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ChalkRecord {
  id: string;
  plate: string;
  officer_name: string | null;
  location_name: string | null;
  status: string;
  chalked_at: string;
  return_by: string;
  infringement_number: string | null;
}

const ParkingOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: parking_chalk_records
  const loadRecords = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('parking_chalk_records')
        .select('id, plate, officer_name, location_name, status, chalked_at, return_by, infringement_number')
        .eq('organization_id', orgId)
        .order('chalked_at', { ascending: false })
        .limit(100);

      if (err) throw err;
      setRecords((data as ChalkRecord[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load parking records');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading parking records...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Parking</h1>
        <p className="subtitle">{records.length} chalk records across the organisation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Plate</th>
              <th>Officer</th>
              <th>Location</th>
              <th>Chalked</th>
              <th>Return By</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center">
                  No records
                </td>
              </tr>
            ) : (
              records.map((r) => (
                <tr key={r.id}>
                  <td>{r.plate}</td>
                  <td>{r.officer_name || '-'}</td>
                  <td>{r.location_name || '-'}</td>
                  <td>{new Date(r.chalked_at).toLocaleString()}</td>
                  <td>{new Date(r.return_by).toLocaleString()}</td>
                  <td>
                    <span className={`status-badge status-${r.status}`}>{r.status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ParkingOversightPage;
