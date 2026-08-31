import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot, Headphones, Plus, Radio, RefreshCw, Siren, Waves } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PttOperationsPage.css';

interface Channel { id: string; name: string; emergency_enabled: boolean; created_at: string; }
interface Transmission { id: string; channel_id: string | null; speaker_user_id: string | null; state: string; started_at: string; ended_at: string | null; emergency: boolean; }
interface Transcript { id: string; transmission_id: string; text: string; confidence: number | null; is_final: boolean; created_at: string; }

const displayState = (state: string) => state.replace(/_/g, ' ');

export default function PttOperationsPage() {
  const { profile } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [newEmergency, setNewEmergency] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!profile?.organizationId) { setLoading(false); return; }
    manual ? setRefreshing(true) : setLoading(true);
    const organizationId = profile.organizationId;
    const [channelResult, transmissionResult, transcriptResult] = await Promise.all([
      supabase.from('ptt_channels').select('id, name, emergency_enabled, created_at').eq('organization_id', organizationId).order('name'),
      supabase.from('ptt_transmissions').select('id, channel_id, speaker_user_id, state, started_at, ended_at, emergency').eq('organization_id', organizationId).order('started_at', { ascending: false }).limit(30),
      supabase.from('radio_transcript_segments').select('id, transmission_id, text, confidence, is_final, created_at').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(40),
    ]);
    const failed = channelResult.error || transmissionResult.error || transcriptResult.error;
    if (failed) setError('Radio evidence could not be refreshed. Check organization access and try again.');
    else {
      setError(null);
      setChannels((channelResult.data ?? []) as Channel[]);
      setTransmissions((transmissionResult.data ?? []) as Transmission[]);
      setTranscripts((transcriptResult.data ?? []) as Transcript[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const channel = supabase
      .channel(`ptt-operations-${profile.organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ptt_transmissions', filter: `organization_id=eq.${profile.organizationId}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'radio_transcript_segments', filter: `organization_id=eq.${profile.organizationId}` }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [load, profile?.organizationId]);

  const createChannel = async (event: FormEvent) => {
    event.preventDefault();
    const name = channelName.trim();
    if (!profile?.organizationId || !name) return;
    setSaving(true);
    const { error: insertError } = await supabase.from('ptt_channels').insert({ organization_id: profile.organizationId, name: name.slice(0, 120), emergency_enabled: newEmergency });
    setSaving(false);
    if (insertError) { setError('Channel could not be created.'); return; }
    setChannelName('');
    setNewEmergency(false);
    void load();
  };

  const toggleEmergency = async (channel: Channel) => {
    const { error: updateError } = await supabase.from('ptt_channels').update({ emergency_enabled: !channel.emergency_enabled }).eq('id', channel.id);
    if (updateError) { setError('Emergency channel setting could not be changed.'); return; }
    void load();
  };

  const activeCount = transmissions.filter(item => item.state === 'started' || item.state === 'emergency').length;
  const emergencyCount = transmissions.filter(item => item.emergency || item.state === 'emergency').length;
  const channelNameById = new Map(channels.map(channel => [channel.id, channel.name]));

  return <div className="ptt-operations">
    <header className="ptt-operations-header">
      <div><span>Field communications</span><h1>Radio Operations</h1><p>Channel control, live transmission evidence, and radio transcript review.</p></div>
      <button type="button" className="ptt-refresh" onClick={() => void load(true)} disabled={refreshing} title="Refresh radio operations"><RefreshCw size={16} className={refreshing ? 'is-spinning' : ''} />Refresh</button>
    </header>
    {error && <div className="ptt-alert" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
    <section className="ptt-metrics" aria-label="Radio status">
      <Metric icon={Radio} label="Configured channels" value={loading ? '...' : String(channels.length)} tone="blue" />
      <Metric icon={Waves} label="Active transmissions" value={loading ? '...' : String(activeCount)} tone={activeCount ? 'teal' : 'neutral'} />
      <Metric icon={Siren} label="Emergency transmissions" value={loading ? '...' : String(emergencyCount)} tone={emergencyCount ? 'red' : 'neutral'} />
      <Metric icon={Headphones} label="Final transcript segments" value={loading ? '...' : String(transcripts.filter(item => item.is_final).length)} tone="green" />
    </section>
    <div className="ptt-workspace-grid">
      <section className="ptt-surface ptt-channel-surface"><div className="ptt-section-title"><div><span>Configuration</span><h2>Radio channels</h2></div><CircleDot size={19} /></div>
        <form className="ptt-create-channel" onSubmit={createChannel}><label><span>Channel name</span><input value={channelName} onChange={event => setChannelName(event.target.value)} maxLength={120} placeholder="e.g. North patrol" required /></label><label className="ptt-emergency-option"><input type="checkbox" checked={newEmergency} onChange={event => setNewEmergency(event.target.checked)} /><span>Emergency enabled</span></label><button type="submit" disabled={saving}><Plus size={16} />{saving ? 'Creating' : 'Add channel'}</button></form>
        <div className="ptt-channel-list">{channels.length === 0 && !loading ? <div className="ptt-empty">No channels have been provisioned for this organization.</div> : channels.map(channel => <article key={channel.id}><div><strong>{channel.name}</strong><small>Created {new Date(channel.created_at).toLocaleDateString('en-NZ')}</small></div><button type="button" onClick={() => void toggleEmergency(channel)} className={channel.emergency_enabled ? 'is-emergency' : ''}><Siren size={14} />{channel.emergency_enabled ? 'Emergency enabled' : 'Emergency disabled'}</button></article>)}</div>
      </section>
      <section className="ptt-surface"><div className="ptt-section-title"><div><span>Live evidence</span><h2>Transmission activity</h2></div><span className={activeCount ? 'ptt-live is-live' : 'ptt-live'}>{activeCount ? 'Live' : 'Quiet'}</span></div>
        <div className="ptt-transmission-list">{transmissions.length === 0 && !loading ? <div className="ptt-empty">No radio transmissions recorded yet.</div> : transmissions.map(item => <article key={item.id}><span className={`ptt-transmission-mark state-${item.state}`}></span><div><strong>{item.channel_id ? channelNameById.get(item.channel_id) ?? 'Unknown channel' : 'Unassigned channel'}</strong><small>{item.speaker_user_id ? 'Officer transmission' : 'System transmission'} · {new Date(item.started_at).toLocaleString('en-NZ')}</small></div>{item.emergency && <span className="ptt-emergency-flag">Emergency</span>}<span className={`ptt-state state-${item.state}`}>{displayState(item.state)}</span></article>)}</div>
      </section>
    </div>
    <section className="ptt-surface ptt-transcript-surface"><div className="ptt-section-title"><div><span>Recorded context</span><h2>Radio transcript</h2></div><CheckCircle2 size={19} /></div><div className="ptt-transcript-list">{transcripts.length === 0 && !loading ? <div className="ptt-empty">Final and interim captions will appear here as transmissions are transcribed.</div> : transcripts.map(item => <article key={item.id}><div><p>{item.text}</p><small>{new Date(item.created_at).toLocaleString('en-NZ')} · {item.is_final ? 'Final' : 'Interim'}{item.confidence !== null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ''}</small></div><span className={item.is_final ? 'ptt-transcript-final' : 'ptt-transcript-interim'}>{item.is_final ? 'Final' : 'Live'}</span></article>)}</div></section>
  </div>;
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Radio; label: string; value: string; tone: string }) { return <div className={`ptt-metric tone-${tone}`}><span><Icon size={19} /></span><div><small>{label}</small><strong>{value}</strong></div></div>; }