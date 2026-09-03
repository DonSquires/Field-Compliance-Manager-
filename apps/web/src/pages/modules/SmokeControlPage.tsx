/**
 * SmokeControlPage.tsx (module: Smoke Control)
 *
 * Canonical schema: client_sites (site selector) + smoke_assessments
 * (organization_id, site_id, complaint_source, smoke_source_type, severity,
 * status, scene_description, action_taken, notes, address, assessed_at).
 * There is no smoke_level/weather_conditions/complainant_site_id column —
 * those were a screen-first guess and have been removed.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useServiceRelationships, type ServiceLocationSite } from '../../context/ServiceRelationshipContext';
import { supabase } from '../../lib/supabase';
import '../PageStyles.css';

interface SmokeAssessment {
  id: string;
  site_id: string | null;
  organization_id: string;
  complaint_source: string | null;
  smoke_source_type: string | null;
  severity: string | null;
  status: string;
  scene_description: string | null;
  action_taken: string | null;
  notes: string | null;
  address: string | null;
  assessed_at: string;
}

interface AssessmentForm {
  complaint_source: string;
  smoke_source_type: string;
  severity: string;
  scene_description: string;
  notes: string;
  complaint_address: string;
  action_taken: string;
  source_confirmed: boolean;
  follow_up_required: boolean;
}

const EMPTY_FORM: AssessmentForm = {
  complaint_source: 'neighbour',
  smoke_source_type: 'nuisance_burning',
  severity: 'moderate',
  scene_description: '',
  notes: '',
  complaint_address: '',
  action_taken: 'no_action',
  source_confirmed: false,
  follow_up_required: false,
};

const SmokeControlPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites, selectedSite, selectSite, loading: relationshipLoading } = useServiceRelationships();
  const [assessments, setAssessments] = useState<SmokeAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<AssessmentForm>(EMPTY_FORM);

  useEffect(() => {
    if (relationshipLoading) return;
    if (selectedSite && selectedAgreementSites.some((site) => site.id === selectedSite.id)) return;
    selectSite(selectedAgreementSites[0]?.id ?? null);
  }, [relationshipLoading, selectedAgreementSites, selectedSite, selectSite]);

  useEffect(() => {
    if (!selectedSite || !selectedAgreementSites.some((site) => site.id === selectedSite.id)) {
      setAssessments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    void loadAssessments(selectedSite.id).finally(() => setLoading(false));
  }, [selectedSite, selectedAgreementSites]);

  const loadAssessments = async (siteId: string) => {
    try {
      // ATLAS READS: smoke_assessments (filtered by site)
      const { data, error: err } = await supabase
        .from('smoke_assessments')
        .select(
          'id, site_id, organization_id, complaint_source, smoke_source_type, severity, status, scene_description, action_taken, notes, address, assessed_at'
        )
        .eq('site_id', siteId)
        .order('assessed_at', { ascending: false });

      if (err) throw err;
      setAssessments((data as SmokeAssessment[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessments');
    }
  };

  const handleSelectSite = (site: ServiceLocationSite) => {
    selectSite(site.id);
  };

  const handleSubmitAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSite || !profile?.organizationId) return;

    try {
      // ATLAS WRITES: smoke_assessments
      const { data, error } = await supabase
        .from('smoke_assessments')
        .insert([
          {
            site_id: selectedSite.id,
            organization_id: profile.organizationId,
            officer_user_id: profile.id,
            officer_id: profile.id,
            complaint_source: formData.complaint_source,
            smoke_source_type: formData.smoke_source_type,
            severity: formData.severity,
            scene_description: formData.scene_description.trim(),
            notes: formData.notes || null,
            complaint_address: formData.complaint_address.trim() || null,
            address: formData.complaint_address.trim() || null,
            action_taken: formData.action_taken,
            source_confirmed: formData.source_confirmed,
            follow_up_required: formData.follow_up_required,
            status: 'open',
          },
        ])
        .select();

      if (error) throw error;

      setAssessments([data[0] as SmokeAssessment, ...assessments]);
      setFormData(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
    }
  };

  const handleMarkActioned = async (assessmentId: string) => {
    try {
      // ATLAS WRITES: smoke_assessments
      const { error } = await supabase
        .from('smoke_assessments')
        .update({ status: 'actioned' })
        .eq('id', assessmentId);

      if (error) throw error;

      setAssessments(
        assessments.map((a) => (a.id === assessmentId ? { ...a, status: 'actioned' } : a))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update assessment');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading smoke control data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container smoke-control-page">
      <header className="page-header">
        <h1>Smoke Control</h1>
        <p className="subtitle">Smoke complaint assessment and enforcement tracking</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="smoke-layout">
        <div className="site-selector">
            <h2>Sites ({selectedAgreementSites.length})</h2>
          <div className="sites-list">
            {selectedAgreementSites.length === 0 ? (
              <div className="empty-state">
                <p>No sites configured for this organisation.</p>
              </div>
            ) : (
              selectedAgreementSites.map((site) => (
                <button
                  key={site.id}
                  className={`site-card ${selectedSite?.id === site.id ? 'active' : ''}`}
                  onClick={() => handleSelectSite(site)}
                >
                  <h3>{site.name}</h3>
                  <p className="site-address">{site.address}</p>
                  {site.site_type && <span className="site-type-badge">{site.site_type}</span>}
                </button>
              ))
            )}
          </div>
        </div>

        {selectedSite && (
          <div className="assessment-details">
            <div className="details-header">
              <h2>{selectedSite.name}</h2>
              <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
                {showForm ? 'Cancel' : '+ New Assessment'}
              </button>
            </div>

            {showForm && (
              <form className="assessment-form" onSubmit={handleSubmitAssessment}>
                <div className="form-group">
                  <label htmlFor="smoke-complaint-source">Complaint source</label>
                  <select
                    id="smoke-complaint-source"
                    value={formData.complaint_source}
                    onChange={(e) => setFormData({ ...formData, complaint_source: e.target.value })}
                  >
                    <option value="neighbour">Neighbour complaint</option>
                    <option value="council_hotline">Council hotline</option>
                    <option value="self_report">Self report</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-source-type">Smoke source type</label>
                  <select
                    id="smoke-source-type"
                    value={formData.smoke_source_type}
                    onChange={(e) => setFormData({ ...formData, smoke_source_type: e.target.value })}
                  >
                    <option value="nuisance_burning">Nuisance burning</option>
                    <option value="industrial">Industrial</option>
                    <option value="domestic_solid_fuel">Domestic solid fuel</option>
                    <option value="vehicle_exhaust">Vehicle exhaust</option>
                    <option value="agricultural">Agricultural</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-severity">Severity</label>
                  <select
                    id="smoke-severity"
                    value={formData.severity}
                    onChange={(e) => setFormData({ ...formData, severity: e.target.value })}
                  >
                    <option value="low">Low</option>
                    <option value="moderate">Moderate</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-complaint-address">Complainant address</label>
                  <input id="smoke-complaint-address" value={formData.complaint_address} onChange={(e) => setFormData({ ...formData, complaint_address: e.target.value })} placeholder="Affected property, if different from source site" />
                </div>
                <div className="form-group">
                  <label htmlFor="smoke-scene">Scene description</label>
                  <textarea
                    id="smoke-scene"
                    required
                    value={formData.scene_description}
                    onChange={(e) => setFormData({ ...formData, scene_description: e.target.value })}
                    rows={3}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-action">Action taken</label>
                  <select id="smoke-action" value={formData.action_taken} onChange={(e) => setFormData({ ...formData, action_taken: e.target.value })}><option value="no_action">No action</option><option value="verbal_warning">Verbal warning</option><option value="abatement_notice">Abatement notice</option><option value="infringement_notice">Infringement notice</option><option value="prosecution_referral">Prosecution referral</option></select>
                </div>
                <div className="form-group">
                  <label htmlFor="smoke-notes">Notes</label>
                  <textarea
                    id="smoke-notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                  />
                </div>

                <label className="form-checkbox"><input type="checkbox" checked={formData.source_confirmed} onChange={(e) => setFormData({ ...formData, source_confirmed: e.target.checked })} /> Source confirmed at the selected site</label>
                <label className="form-checkbox"><input type="checkbox" checked={formData.follow_up_required} onChange={(e) => setFormData({ ...formData, follow_up_required: e.target.checked })} /> Follow-up required</label>

                <button type="submit" className="btn btn-primary btn-block" disabled={!formData.scene_description.trim() || !formData.source_confirmed}>
                  Submit Assessment
                </button>
              </form>
            )}

            <div className="assessment-history">
              <h3>Assessment History ({assessments.length})</h3>
              {assessments.length === 0 ? (
                <div className="empty-state">
                  <p>No assessments recorded for this site yet.</p>
                </div>
              ) : (
                <div className="assessments-list">
                  {assessments.map((assessment) => (
                    <div key={assessment.id} className="assessment-card">
                      <div className="assessment-header">
                        <div>
                          <h4>{new Date(assessment.assessed_at).toLocaleString()}</h4>
                          <span className={`status-badge status-${assessment.status}`}>
                            {assessment.status}
                          </span>
                        </div>
                        {assessment.severity && (
                          <span className={`severity-badge severity-${assessment.severity}`}>
                            {assessment.severity}
                          </span>
                        )}
                      </div>
                      {assessment.smoke_source_type && (
                        <p className="assessment-source">Source: {assessment.smoke_source_type}</p>
                      )}
                      {assessment.scene_description && (
                        <p className="assessment-notes">{assessment.scene_description}</p>
                      )}
                      {assessment.notes && <p className="assessment-notes">{assessment.notes}</p>}
                      {assessment.status === 'open' && (
                        <div className="assessment-actions">
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleMarkActioned(assessment.id)}
                          >
                            Mark Actioned
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmokeControlPage;
