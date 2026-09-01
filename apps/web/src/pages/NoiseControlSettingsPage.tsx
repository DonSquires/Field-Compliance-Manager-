/**
 * NoiseControlSettingsPage.tsx (Admin field-ops sub-area: 'noise-control-settings')
 *
 * Canonical schema: noise_module_config (one row per org, upserted on save).
 * Lets admins tune the excessive_threshold, skip_verbal_warning, and
 * legislative_text without a code change, per the spec.
 *
 * DEFERRED: volume_bands/time_bands/tone_bands, supplementary_factors,
 * supplementary_factor_config, and permanent_abatement_list are richer
 * list/JSON editors and are out of scope for this pass -- they keep their
 * schema defaults until a follow-up slice builds that UI.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { EXCESSIVE_THRESHOLD_DEFAULT } from '../lib/noiseMatrixSchema';
import './PageStyles.css';

const NoiseControlSettingsPage: React.FC = () => {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    excessiveThreshold: EXCESSIVE_THRESHOLD_DEFAULT,
    skipVerbalWarning: false,
    legislativeText: '',
  });

  // ATLAS READS: noise_module_config
  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('noise_module_config')
      .select('excessive_threshold, skip_verbal_warning, legislative_text')
      .eq('organization_id', profile.organizationId)
      .maybeSingle();
    if (err) {
      setError(err.message);
    } else if (data) {
      setForm({
        excessiveThreshold: data.excessive_threshold ?? EXCESSIVE_THRESHOLD_DEFAULT,
        skipVerbalWarning: Boolean(data.skip_verbal_warning),
        legislativeText: data.legislative_text ?? '',
      });
    }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    // ATLAS WRITES: noise_module_config
    const { error: err } = await supabase.from('noise_module_config').upsert(
      {
        organization_id: profile.organizationId,
        excessive_threshold: form.excessiveThreshold,
        skip_verbal_warning: form.skipVerbalWarning,
        legislative_text: form.legislativeText.trim() || null,
      },
      { onConflict: 'organization_id' },
    );

    if (err) setError(err.message);
    else setSaved(true);
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading noise control settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Noise Control Settings</h1>
        <p className="subtitle">Per-organisation TDC matrix threshold and enforcement configuration</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {saved && <div className="alert alert-success">Settings saved.</div>}

      <form className="assessment-form" onSubmit={handleSave}>
        <div className="form-group">
          <label>Excessive threshold (TDC matrix total)</label>
          <input
            type="number"
            min={0}
            max={10}
            value={form.excessiveThreshold}
            onChange={(e) => setForm({ ...form, excessiveThreshold: Number(e.target.value) })}
          />
          <p className="contact-meta">TDC standard default is 5. A matrix total at or above this is classified excessive.</p>
        </div>
        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={form.skipVerbalWarning}
              onChange={(e) => setForm({ ...form, skipVerbalWarning: e.target.checked })}
            />{' '}
            Skip the verbal warning tier — issue an abatement notice on the first excessive finding
          </label>
        </div>
        <div className="form-group">
          <label>Legislative framework text</label>
          <textarea
            rows={3}
            value={form.legislativeText}
            onChange={(e) => setForm({ ...form, legislativeText: e.target.value })}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </form>
    </div>
  );
};

export default NoiseControlSettingsPage;
