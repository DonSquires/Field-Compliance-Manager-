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
}

const EMPTY_FORM: AssessmentForm = {
  complaint_source: 'public',
  smoke_source_type: 'outdoor_burning',
  severity: 'moderate',
  scene_description: '',
  notes: '',
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
            complaint_source: formData.complaint_source,
            smoke_source_type: formData.smoke_source_type,
            severity: formData.severity,
            scene_description: formData.scene_description || null,
            notes: formData.notes || null,
            address: selectedSite.address,
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
                  <label>Complaint Source</label>
                  <select
                    value={formData.complaint_source}
                    onChange={(e) => setFormData({ ...formData, complaint_source: e.target.value })}
                  >
                    <option value="public">Public complaint</option>
                    <option value="council">Council referral</option>
                    <option value="patrol">Patrol observation</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Smoke Source Type</label>
                  <select
                    value={formData.smoke_source_type}
                    onChange={(e) => setFormData({ ...formData, smoke_source_type: e.target.value })}
                  >
                    <option value="outdoor_burning">Outdoor burning</option>
                    <option value="industrial">Industrial</option>
                    <option value="domestic_fire">Domestic fire</option>
                    <option value="vehicle">Vehicle</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Severity</label>
                  <select
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
                  <label>Scene Description</label>
                  <textarea
                    value={formData.scene_description}
                    onChange={(e) => setFormData({ ...formData, scene_description: e.target.value })}
                    rows={3}
                  />
                </div>

                <div className="form-group">
                  <label>Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                  />
                </div>

                <button type="submit" className="btn btn-primary btn-block">
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
