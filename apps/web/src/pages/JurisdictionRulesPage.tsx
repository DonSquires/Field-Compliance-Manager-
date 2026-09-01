/**
 * JurisdictionRulesPage.tsx (Admin field-ops sub-area: 'jurisdiction-rules')
 *
 * Canonical schema: jurisdiction_rule_sets -- "Jurisdiction-specific
 * legal/operational rules per module. Supports councils, government, and
 * private enterprise." Was SELECT-only under RLS despite the org already
 * being able to author its own bylaws elsewhere (location_zones); nothing
 * could ever create or edit a rule set.
 *
 * Deliberately covers every module_key in the client_site_patrol_config
 * CHECK constraint, not just one vertical -- this is a data-driven app:
 * organisations configure their own bylaws per module, not a hardcoded
 * per-vertical rule engine.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

const MODULE_KEYS = [
  'freedom_camping',
  'parking_enforcement',
  'noise_control',
  'biosecurity',
  'smoke_complaints',
  'static_guarding',
  'access_control',
  'ems',
  'alarm_response',
  'welfare_check',
  'general_patrol',
];

interface RuleSet {
  id: string;
  module_key: string;
  name: string;
  jurisdiction_name: string;
  rules: Record<string, unknown>;
  created_at: string;
}

const emptyForm = { module_key: MODULE_KEYS[0], name: '', jurisdiction_name: '', rulesText: '{}' };

const JurisdictionRulesPage: React.FC = () => {
  const { profile } = useAuth();
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  // ATLAS READS: jurisdiction_rule_sets
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('jurisdiction_rule_sets')
      .select('id, module_key, name, jurisdiction_name, rules, created_at')
      .eq('organization_id', orgId)
      .order('module_key')
      .order('name');
    if (err) setError(err.message);
    else setRuleSets((data as RuleSet[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (ruleSet: RuleSet) => {
    setEditingId(ruleSet.id);
    setForm({
      module_key: ruleSet.module_key,
      name: ruleSet.name,
      jurisdiction_name: ruleSet.jurisdiction_name,
      rulesText: JSON.stringify(ruleSet.rules ?? {}, null, 2),
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId || saving) return;

    let parsedRules: Record<string, unknown>;
    try {
      parsedRules = form.rulesText.trim() ? JSON.parse(form.rulesText) : {};
    } catch {
      setError('Rules must be valid JSON.');
      return;
    }

    setSaving(true);
    setError(null);

    if (editingId) {
      // ATLAS WRITES: jurisdiction_rule_sets
      const { error: err } = await supabase
        .from('jurisdiction_rule_sets')
        .update({ module_key: form.module_key, name: form.name.trim(), jurisdiction_name: form.jurisdiction_name.trim(), rules: parsedRules })
        .eq('id', editingId);
      if (err) setError(err.message);
      else {
        resetForm();
        await load();
      }
    } else {
      // ATLAS WRITES: jurisdiction_rule_sets
      const { error: err } = await supabase.from('jurisdiction_rule_sets').insert([
        {
          organization_id: profile.organizationId,
          module_key: form.module_key,
          name: form.name.trim(),
          jurisdiction_name: form.jurisdiction_name.trim(),
          rules: parsedRules,
        },
      ]);
      if (err) setError(err.message);
      else {
        resetForm();
        await load();
      }
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    setError(null);
    // ATLAS WRITES: jurisdiction_rule_sets
    const { error: err } = await supabase.from('jurisdiction_rule_sets').delete().eq('id', id);
    if (err) setError(err.message);
    else {
      setRuleSets(ruleSets.filter((r) => r.id !== id));
      if (editingId === id) resetForm();
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading jurisdiction rule sets...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Jurisdiction Rules</h1>
        <p className="subtitle">{ruleSets.length} rule set(s) — org-authored bylaws per module</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="assessment-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Module</label>
          <select value={form.module_key} onChange={(e) => setForm({ ...form, module_key: e.target.value })}>
            {MODULE_KEYS.map((key) => (
              <option key={key} value={key}>
                {key.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Name</label>
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Beach Reserve Dog Control" />
        </div>
        <div className="form-group">
          <label>Jurisdiction</label>
          <input
            required
            value={form.jurisdiction_name}
            onChange={(e) => setForm({ ...form, jurisdiction_name: e.target.value })}
            placeholder="e.g. Nelson City Council"
          />
        </div>
        <div className="form-group">
          <label>Rules (JSON)</label>
          <textarea
            rows={8}
            value={form.rulesText}
            onChange={(e) => setForm({ ...form, rulesText: e.target.value })}
            placeholder='{"dog_control_hours": "10am-5pm leash-free prohibited", "vehicle_permit_required": true}'
          />
          <p className="contact-meta">Free-form structured rules for this module/jurisdiction — read by enforcement workflows as configuration, not code.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Rule Set'}
          </button>
          {editingId && (
            <button type="button" className="btn btn-secondary" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {ruleSets.length === 0 ? (
          <div className="empty-state">
            <p>No jurisdiction rule sets yet.</p>
          </div>
        ) : (
          ruleSets.map((ruleSet) => (
            <div key={ruleSet.id} className="contact-card">
              <div className="contact-header">
                <h3>{ruleSet.name}</h3>
                <span className="badge">{ruleSet.module_key.replaceAll('_', ' ')}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">{ruleSet.jurisdiction_name}</p>
                <pre className="contact-meta">{JSON.stringify(ruleSet.rules, null, 2)}</pre>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(ruleSet)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleDelete(ruleSet.id)}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default JurisdictionRulesPage;
