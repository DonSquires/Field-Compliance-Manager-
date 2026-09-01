/**
 * OfficerVoiceConsentPage.tsx (Officer module: 'voice_consent')
 *
 * Canonical schema: radio_voice_consents (own history). Consent must
 * always be self-attested, so grant/revoke goes through
 * record_voice_consent() rather than a direct table write.
 *
 * DEFERRED: the live PTT audio/floor-control experience, voice profile
 * registration itself, and STT/translation captions are not built here --
 * this page only lets an officer see and control their consent status.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ConsentRecord {
  consented: boolean;
  revoked_at: string | null;
  created_at: string;
}

const OfficerVoiceConsentPage: React.FC = () => {
  const { profile } = useAuth();
  const [current, setCurrent] = useState<ConsentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: radio_voice_consents
  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('radio_voice_consents')
      .select('consented, revoked_at, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (err) setError(err.message);
    else setCurrent((data as ConsentRecord) ?? null);
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSetConsent = async (consented: boolean) => {
    setSaving(true);
    setError(null);
    // ATLAS WRITES: radio_voice_consents (via record_voice_consent)
    const { error: err } = await supabase.rpc('record_voice_consent', { p_consented: consented });
    if (err) setError(err.message);
    else await load();
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading voice consent status...</p>
        </div>
      </div>
    );
  }

  const isConsented = current?.consented === true;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Voice Consent</h1>
        <p className="subtitle">Required before voice profile registration for radio transcription/translation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="contact-card">
        <div className="contact-header">
          <h3>Current status</h3>
          <span className={`badge ${isConsented ? '' : 'is-alert'}`}>{isConsented ? 'Consented' : 'Not consented'}</span>
        </div>
        <div className="contact-details">
          {current && (
            <p className="contact-meta">
              Last updated {new Date(current.created_at).toLocaleString()}
              {current.revoked_at && ` · Revoked ${new Date(current.revoked_at).toLocaleString()}`}
            </p>
          )}
          <p>Consent is fully revocable at any time.</p>
          {isConsented ? (
            <button type="button" className="btn btn-secondary btn-block" disabled={saving} onClick={() => handleSetConsent(false)}>
              {saving ? 'Updating…' : 'Revoke Consent'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={() => handleSetConsent(true)}>
              {saving ? 'Updating…' : 'Grant Consent'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default OfficerVoiceConsentPage;
