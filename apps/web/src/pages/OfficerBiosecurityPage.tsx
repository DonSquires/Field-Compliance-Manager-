/**
 * OfficerBiosecurityPage.tsx (Officer module: 'biosecurity')
 *
 * Canonical schema: biosecurity_assessments (species_name, density_estimate,
 * action_taken, mpi_referral_number). Officer-scoped: filtered to the
 * signed-in officer's own assessments.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type DensityEstimate = 'isolated' | 'scattered' | 'moderate' | 'dense' | 'severe' | 'not_found';
type ActionTaken = 'no_action' | 'advisory_notice' | 'notice_of_direction' | 'infringement_notice' | 'mpi_referral';

interface BiosecurityAssessment {
  id: string;
  species_name: string | null;
  species_confirmed: boolean;
  density_estimate: DensityEstimate | null;
  action_taken: ActionTaken | null;
  scene_description: string | null;
  location_name: string | null;
  notice_number: string | null;
  mpi_referral_number: string | null;
  follow_up_required: boolean;
  notes: string | null;
  status: string;
  assessed_at: string;
}

interface ClientSite { id: string; name: string; address: string | null; }

const OfficerBiosecurityPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]);
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    species_name: '',
    species_confirmed: false,
    density_estimate: 'scattered' as DensityEstimate,
    action_taken: 'no_action' as ActionTaken,
    scene_description: '',
    location_name: '',
    site_id: '',
    protected_land_address: '',
    protected_land_site_id: '',
    notice_number: '',
    mpi_referral_number: '',
    follow_up_required: false,
    notes: '',
  });

  // ATLAS READS: biosecurity_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const [{ data, error: err }, siteResult] = await Promise.all([
        supabase
          .from('biosecurity_assessments')
          .select('id, species_name, species_confirmed, density_estimate, action_taken, scene_description, location_name, notice_number, mpi_referral_number, follow_up_required, notes, status, assessed_at')
          .or(`officer_user_id.eq.${profile.id},officer_id.eq.${profile.id}`)
          .order('assessed_at', { ascending: false }),
        supabase.from('client_sites').select('id, name, address').eq('active', true).order('name'),
      ]);

      if (err) throw err;
      setAssessments((data as BiosecurityAssessment[]) || []);
      if (!siteResult.error) setSites((siteResult.data as ClientSite[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load biosecurity assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadAssessments();
  }, [loadAssessments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      // ATLAS WRITES: biosecurity_assessments
      const { data, error } = await supabase
        .from('biosecurity_assessments')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_user_id: profile.id,
            officer_id: profile.id,
            officer_name: profile.displayName,
            species_name: form.species_name || null,
            species_confirmed: form.species_confirmed,
            density_estimate: form.density_estimate,
            action_taken: form.action_taken,
            scene_description: form.scene_description || null,
            location_name: form.location_name || null,
            site_id: form.site_id || null,
            protected_land_address: form.protected_land_address || null,
            protected_land_site_id: form.protected_land_site_id || null,
            notice_number: form.notice_number || null,
            mpi_referral_number: form.mpi_referral_number || null,
            follow_up_required: form.follow_up_required,
            notes: form.notes || null,
            status: 'open',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as BiosecurityAssessment, ...assessments]);
      setForm({ species_name: '', species_confirmed: false, density_estimate: 'scattered', action_taken: 'no_action', scene_description: '', location_name: '', site_id: '', protected_land_address: '', protected_land_site_id: '', notice_number: '', mpi_referral_number: '', follow_up_required: false, notes: '' });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading biosecurity assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Biosecurity</h1>
        <p className="subtitle">{assessments.length} assessments recorded</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ New Assessment'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Species</label>
            <input type="text" value={form.species_name} onChange={(e) => setForm({ ...form, species_name: e.target.value })} />
          </div>
          <label className="form-checkbox"><input type="checkbox" checked={form.species_confirmed} onChange={(e) => setForm({ ...form, species_confirmed: e.target.checked })} />Species identification confirmed</label>
          <div className="form-row">
            <div className="form-group"><label>Observed site</label><select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })}><option value="">No matched site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></div>
            <div className="form-group"><label>Observed location</label><input type="text" value={form.location_name} onChange={(e) => setForm({ ...form, location_name: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Density</label>
              <select
                value={form.density_estimate}
                onChange={(e) => setForm({ ...form, density_estimate: e.target.value as DensityEstimate })}
              >
                <option value="isolated">Isolated</option>
                <option value="scattered">Scattered</option>
                <option value="moderate">Moderate</option>
                <option value="dense">Dense</option>
                <option value="severe">Severe</option>
                <option value="not_found">Not Found</option>
              </select>
            </div>
            <div className="form-group">
              <label>Action Taken</label>
              <select
                value={form.action_taken}
                onChange={(e) => setForm({ ...form, action_taken: e.target.value as ActionTaken })}
              >
                <option value="no_action">No Action</option>
                <option value="advisory_notice">Advisory Notice</option>
                <option value="notice_of_direction">Notice of Direction</option>
                <option value="infringement_notice">Infringement Notice</option>
                <option value="mpi_referral">MPI Referral</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Scene Description</label>
            <textarea rows={3} value={form.scene_description} onChange={(e) => setForm({ ...form, scene_description: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group"><label>Protected land site</label><select value={form.protected_land_site_id} onChange={(e) => { const site = sites.find((candidate) => candidate.id === e.target.value); setForm({ ...form, protected_land_site_id: e.target.value, protected_land_address: site?.address ?? form.protected_land_address }); }}><option value="">No matched site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></div>
            <div className="form-group"><label>Protected land address</label><input type="text" value={form.protected_land_address} onChange={(e) => setForm({ ...form, protected_land_address: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Notice number</label><input type="text" value={form.notice_number} onChange={(e) => setForm({ ...form, notice_number: e.target.value })} /></div>
            <div className="form-group"><label>MPI referral number</label><input type="text" value={form.mpi_referral_number} onChange={(e) => setForm({ ...form, mpi_referral_number: e.target.value })} /></div>
          </div>
          <div className="form-group"><label>Operational notes</label><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <label className="form-checkbox"><input type="checkbox" checked={form.follow_up_required} onChange={(e) => setForm({ ...form, follow_up_required: e.target.checked })} />Follow-up required</label>
          <button type="submit" className="btn btn-primary btn-block">
            Submit Assessment
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {assessments.length === 0 ? (
          <div className="empty-state">
            <p>No assessments recorded yet.</p>
          </div>
        ) : (
          assessments.map((a) => (
            <div key={a.id} className="contact-card">
              <div className="contact-header">
                <h3>{a.species_name || 'Unidentified species'}</h3>
                <span className={`status-badge status-${a.status}`}>{a.status}</span>
              </div>
              <div className="contact-details">
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">Species: {a.species_confirmed ? 'confirmed' : 'unconfirmed'}</p>
                {a.location_name && <p className="contact-meta">Location: {a.location_name}</p>}
                {a.notice_number && <p className="contact-meta">Notice: {a.notice_number}</p>}
                {a.mpi_referral_number && <p className="contact-meta">MPI referral: {a.mpi_referral_number}</p>}
                {a.notes && <p>{a.notes}</p>}
                <p className="contact-meta">
                  {a.density_estimate} · {a.action_taken} · {a.follow_up_required ? 'follow-up required · ' : ''}{new Date(a.assessed_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerBiosecurityPage;
