/**
 * OrganizationSetupPage.tsx
 *
 * Canonical schema: organizations (profile fields, enforcement_workflow_mode,
 * jurisdiction_verification) + organization_modules (per-module enablement)
 * + notice_templates (read-only reference for enforcement notice config).
 * Jurisdiction geometry verification is a Bob-assisted workflow
 * (bob-jurisdiction-preview / bob_agentic_actions) not yet wired here — do
 * not fabricate that integration.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface OrgProfile {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  enforcement_workflow_mode: string;
  jurisdiction_verification: string;
  status: string;
}

interface ModuleRow {
  id: string;
  module_key: string;
  enabled: boolean;
}

interface NoticeTemplate {
  id: string;
  notice_type: string;
  version: number;
  is_active: boolean;
  authorising_act: string;
}

const ENFORCEMENT_MODES = ['admin_first', 'officer_direct', 'hybrid'];

const OrganizationSetupPage: React.FC = () => {
  const { profile } = useAuth();
  const [org, setOrg] = useState<OrgProfile | null>(null);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [templates, setTemplates] = useState<NoticeTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: organizations, organization_modules, notice_templates
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const [orgRes, modulesRes, templatesRes] = await Promise.all([
        supabase
          .from('organizations')
          .select(
            'id, name, contact_email, contact_phone, billing_email, billing_address, enforcement_workflow_mode, jurisdiction_verification, status'
          )
          .eq('id', orgId)
          .single(),
        supabase.from('organization_modules').select('id, module_key, enabled').eq('organization_id', orgId),
        supabase
          .from('notice_templates')
          .select('id, notice_type, version, is_active, authorising_act')
          .eq('organization_id', orgId),
      ]);

      if (orgRes.error) throw orgRes.error;
      if (modulesRes.error) throw modulesRes.error;
      if (templatesRes.error) throw templatesRes.error;

      setOrg(orgRes.data as OrgProfile);
      setModules((modulesRes.data as ModuleRow[]) || []);
      setTemplates((templatesRes.data as NoticeTemplate[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organisation setup');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;

    try {
      setSaving(true);
      setError(null);

      // ATLAS WRITES: organizations
      const { error } = await supabase
        .from('organizations')
        .update({
          contact_email: org.contact_email,
          contact_phone: org.contact_phone,
          billing_email: org.billing_email,
          billing_address: org.billing_address,
          enforcement_workflow_mode: org.enforcement_workflow_mode,
        })
        .eq('id', org.id);

      if (error) throw error;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save organisation profile');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleModule = async (mod: ModuleRow) => {
    try {
      // ATLAS WRITES: organization_modules
      const { error } = await supabase
        .from('organization_modules')
        .update({ enabled: !mod.enabled })
        .eq('id', mod.id);

      if (error) throw error;
      setModules(modules.map((m) => (m.id === mod.id ? { ...m, enabled: !m.enabled } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update module');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading organisation setup...</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <p>Organisation profile not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Organization Setup</h1>
        <p className="subtitle">{org.name}</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <section className="reports-section">
        <h2>Profile</h2>
        <form className="settings-form" onSubmit={handleSaveProfile}>
          <div className="form-row">
            <div className="form-group">
              <label>Contact Email</label>
              <input
                type="email"
                value={org.contact_email || ''}
                onChange={(e) => setOrg({ ...org, contact_email: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Contact Phone</label>
              <input
                type="tel"
                value={org.contact_phone || ''}
                onChange={(e) => setOrg({ ...org, contact_phone: e.target.value })}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Billing Email</label>
              <input
                type="email"
                value={org.billing_email || ''}
                onChange={(e) => setOrg({ ...org, billing_email: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Billing Address</label>
              <input
                type="text"
                value={org.billing_address || ''}
                onChange={(e) => setOrg({ ...org, billing_address: e.target.value })}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Enforcement Workflow Mode</label>
            <select
              value={org.enforcement_workflow_mode}
              onChange={(e) => setOrg({ ...org, enforcement_workflow_mode: e.target.value })}
            >
              {ENFORCEMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Jurisdiction Verification</label>
            <p className="contact-meta">
              {org.jurisdiction_verification === 'verified' ? '✓ Verified' : 'Unverified'} (managed via Bob
              jurisdiction review, not editable here)
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Profile'}
          </button>
        </form>
      </section>

      <section className="reports-section">
        <h2>Modules ({modules.length})</h2>
        <div className="contacts-list">
          {modules.length === 0 ? (
            <div className="empty-state">
              <p>No module configuration for this organisation.</p>
            </div>
          ) : (
            modules.map((mod) => (
              <div key={mod.id} className="contact-card">
                <div className="contact-header">
                  <h3>{mod.module_key}</h3>
                  <button
                    className={`btn btn-sm ${mod.enabled ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleToggleModule(mod)}
                  >
                    {mod.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Notice Templates ({templates.length})</h2>
        <div className="contacts-list">
          {templates.length === 0 ? (
            <div className="empty-state">
              <p>No notice templates configured.</p>
            </div>
          ) : (
            templates.map((t) => (
              <div key={t.id} className="contact-card">
                <div className="contact-header">
                  <h3>{t.notice_type}</h3>
                  <span className={`status-badge status-${t.is_active ? 'active' : 'inactive'}`}>
                    v{t.version} · {t.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <p className="contact-meta">{t.authorising_act}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

export default OrganizationSetupPage;
