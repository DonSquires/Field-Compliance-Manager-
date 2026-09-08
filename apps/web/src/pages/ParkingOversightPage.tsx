/**
 * ParkingOversightPage.tsx (Admin field-ops sub-area: 'parking')
 *
 * Canonical schema: parking_chalk_records, org-wide oversight — distinct
 * from OfficerParkingPage which is the officer's own chalk/return workflow.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
  movement_detected: boolean | null;
  bob_classification: string | null;
  bob_confidence: number | null;
  effective_time_limit_minutes: number | null;
  sign_confidence: number | null;
  rego_status: string | null;
  wof_status: string | null;
  cof_status: string | null;
  vehicle_compliance_flags: Record<string, unknown> | null;
}

type ParkingFilter = 'all' | 'active' | 'overdue' | 'review';

const ParkingOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ParkingFilter>('all');

  // ATLAS READS: parking_chalk_records
  const loadRecords = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('parking_chalk_records')
        .select('id, plate, officer_name, location_name, status, chalked_at, return_by, infringement_number, movement_detected, bob_classification, bob_confidence, effective_time_limit_minutes, sign_confidence, rego_status, wof_status, cof_status, vehicle_compliance_flags')
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

  const overdueCount = records.filter((record) => record.status === 'active' && new Date(record.return_by).getTime() < Date.now()).length;
  const reviewCount = records.filter((record) => record.status === 'active' && (record.movement_detected === null || record.bob_classification === 'review_required' || record.rego_status === 'expired' || record.wof_status === 'expired' || record.cof_status === 'expired')).length;
  const visibleRecords = useMemo(() => records.filter((record) => {
    if (filter === 'active') return record.status === 'active';
    if (filter === 'overdue') return record.status === 'active' && new Date(record.return_by).getTime() < Date.now();
    if (filter === 'review') return record.status === 'active' && (record.movement_detected === null || record.bob_classification === 'review_required' || record.rego_status === 'expired' || record.wof_status === 'expired' || record.cof_status === 'expired');
    return true;
  }), [filter, records]);

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

      <section className="reports-section" aria-label="Parking workload"><div className="contacts-list"><div className="contact-card"><strong>{records.length}</strong><span>Total records</span></div><div className="contact-card"><strong>{overdueCount}</strong><span>Overdue returns</span></div><div className="contact-card"><strong>{reviewCount}</strong><span>Review required</span></div></div></section>
      <div role="tablist" aria-label="Parking records" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>{(['all', 'active', 'overdue', 'review'] as ParkingFilter[]).map((item) => <button type="button" role="tab" aria-selected={filter === item} className="btn btn-sm btn-secondary" onClick={() => setFilter(item)} key={item}>{item === 'all' ? 'All' : item === 'review' ? 'Review required' : item[0].toUpperCase() + item.slice(1)}</button>)}</div>

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
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center">
                  No records
                </td>
              </tr>
            ) : (
              visibleRecords.map((r) => (
                <tr key={r.id}>
                  <td>{r.plate}</td>
                  <td>{r.officer_name || '-'}</td>
                  <td>{r.location_name || '-'}</td>
                  <td>{new Date(r.chalked_at).toLocaleString()}</td>
                  <td>{new Date(r.return_by).toLocaleString()}</td>
                  <td><span className={`status-badge status-${r.status}`}>{r.status}</span>{r.status === 'active' && new Date(r.return_by).getTime() < Date.now() && <small> · overdue</small>}</td>
                  <td><strong>{r.movement_detected === true ? 'Moved' : r.movement_detected === false ? 'Stationary' : 'Movement unconfirmed'}</strong><small>{r.bob_classification || 'No Bob classification'}{r.bob_confidence != null ? ` · ${Math.round(r.bob_confidence * 100)}%` : ''}</small><small>{r.effective_time_limit_minutes ? `${r.effective_time_limit_minutes} min limit` : 'Time limit unavailable'} · Rego {r.rego_status || 'unknown'} · WOF {r.wof_status || 'unknown'} · CoF {r.cof_status || 'unknown'}</small></td>
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
