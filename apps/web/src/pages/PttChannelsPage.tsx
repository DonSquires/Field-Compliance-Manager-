/**
 * PttChannelsPage.tsx (Admin field-ops sub-area: 'ptt-channels')
 *
 * Canonical schema: ptt_channels (admin-managed directly -- RLS already
 * grants org-admin INSERT/UPDATE, no RPC needed).
 *
 * DEFERRED: this only manages the channel registry (name, emergency
 * broadcast flag). The live PTT audio/floor-control experience runs
 * against ptt-server (a standalone WebSocket signalling service with no
 * Supabase connection today) and is not built here -- persisting
 * ptt_transmissions from real transmissions, and the
 * radio_transcript_segments/radio_translation_segments STT/translation
 * pipeline, both require further infrastructure work on that service.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface PttChannel {
  id: string;
  name: string;
  emergency_enabled: boolean;
}

const PttChannelsPage: React.FC = () => {
  const { profile } = useAuth();
  const [channels, setChannels] = useState<PttChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  // ATLAS READS: ptt_channels
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.from('ptt_channels').select('id, name, emergency_enabled').eq('organization_id', orgId).order('name');
    if (err) setError(err.message);
    else setChannels((data as PttChannel[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    // ATLAS WRITES: ptt_channels
    const { error: err } = await supabase.from('ptt_channels').insert([{ organization_id: profile.organizationId, name: name.trim() }]);
    if (err) setError(err.message);
    else {
      setName('');
      await load();
    }
    setSaving(false);
  };

  const handleToggleEmergency = async (channel: PttChannel) => {
    setError(null);
    // ATLAS WRITES: ptt_channels
    const { error: err } = await supabase.from('ptt_channels').update({ emergency_enabled: !channel.emergency_enabled }).eq('id', channel.id);
    if (err) setError(err.message);
    else setChannels(channels.map((c) => (c.id === channel.id ? { ...c, emergency_enabled: !c.emergency_enabled } : c)));
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading PTT channels...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>PTT Channels</h1>
        <p className="subtitle">{channels.length} channel(s)</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="assessment-form" onSubmit={handleCreate}>
        <div className="form-group">
          <label>Channel name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Channel 1" />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={saving}>
          {saving ? 'Creating…' : 'Create Channel'}
        </button>
      </form>

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {channels.length === 0 ? (
          <div className="empty-state">
            <p>No PTT channels configured.</p>
          </div>
        ) : (
          channels.map((channel) => (
            <div key={channel.id} className="contact-card">
              <div className="contact-header">
                <h3>{channel.name}</h3>
                <span className={`badge ${channel.emergency_enabled ? '' : 'is-alert'}`}>{channel.emergency_enabled ? 'Emergency enabled' : 'Emergency disabled'}</span>
              </div>
              <div className="contact-details">
                <button type="button" className="btn btn-secondary btn-block" onClick={() => handleToggleEmergency(channel)}>
                  {channel.emergency_enabled ? 'Disable Emergency Broadcast' : 'Enable Emergency Broadcast'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default PttChannelsPage;
