import { useEffect, useRef, useState } from 'react';
import { Mic, Radio, VolumeX } from 'lucide-react';
import { env } from '../lib/env';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import './PttBar.css';

interface Channel {
  id: string;
  name: string;
}

type RadioState = 'loading' | 'unavailable' | 'offline' | 'connecting' | 'ready' | 'transmitting' | 'error';

export function PttBar() {
  const { profile } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [state, setState] = useState<RadioState>('loading');
  const [message, setMessage] = useState('Loading radio channels');
  const socketRef = useRef<WebSocket | null>(null);
  const joinedRef = useRef(false);
  const clientIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const transmissionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadChannels = async () => {
      if (!profile?.organizationId) {
        if (active) {
          setState('unavailable');
          setMessage('Radio unavailable');
        }
        return;
      }
      const { data, error } = await supabase
        .from('ptt_channels')
        .select('id, name')
        .eq('organization_id', profile.organizationId)
        .order('name');
      if (!active) return;
      if (error) {
        setState('error');
        setMessage('Radio channels could not be loaded');
        return;
      }
      const nextChannels = (data ?? []) as Channel[];
      setChannels(nextChannels);
      setChannelId(current => current || nextChannels[0]?.id || '');
      setState(nextChannels.length ? 'offline' : 'unavailable');
      setMessage(nextChannels.length ? 'Radio offline' : 'No radio channel assigned');
    };
    void loadChannels();
    return () => { active = false; };
  }, [profile?.organizationId]);

  useEffect(() => () => {
    socketRef.current?.close();
    streamRef.current?.getTracks().forEach(track => track.stop());
    peersRef.current.forEach(peer => peer.close());
  }, []);

  const sendSignal = (to: string, data: RTCSessionDescriptionInit | RTCIceCandidateInit) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'signal', to, data }));
  };

  const createPeer = (peerId: string) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;
    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
    streamRef.current?.getTracks().forEach(track => peer.addTrack(track, streamRef.current!));
    peer.onicecandidate = event => {
      if (event.candidate) sendSignal(peerId, event.candidate.toJSON());
    };
    peer.ontrack = event => {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => undefined);
    };
    peersRef.current.set(peerId, peer);
    return peer;
  };

  const beginTransmission = async () => {
    if (!profile?.organizationId || transmissionIdRef.current) return;
    const { data, error } = await supabase
      .from('ptt_transmissions')
      .insert({ organization_id: profile.organizationId, channel_id: channelId, speaker_user_id: profile.id, state: 'started' })
      .select('id')
      .single();
    if (error || !data?.id) {
      socketRef.current?.send(JSON.stringify({ type: 'floor_release' }));
      setState('error');
      setMessage('Transmission audit could not be confirmed');
      return;
    }
    transmissionIdRef.current = data.id;
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = true; });
    setState('transmitting');
    setMessage('Transmitting');
  };

  const endTransmission = async () => {
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = false; });
    const transmissionId = transmissionIdRef.current;
    transmissionIdRef.current = null;
    if (transmissionId) {
      const { error } = await supabase
        .from('ptt_transmissions')
        .update({ state: 'ended', ended_at: new Date().toISOString() })
        .eq('id', transmissionId);
      if (error) setMessage('Audio stopped; audit close pending');
    }
    setState('ready');
    setMessage('Radio ready');
  };

  const connect = async () => {
    if (!channelId) return;
    socketRef.current?.close();
    peersRef.current.forEach(peer => peer.close());
    peersRef.current.clear();
    joinedRef.current = false;
    setState('connecting');
    setMessage('Connecting radio');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getAudioTracks().forEach(track => { track.enabled = false; });
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = stream;
    } catch {
      setState('error');
      setMessage('Microphone access is required');
      return;
    }
    const { data, error } = await supabase.functions.invoke('ptt-session', { body: { channelId } });
    if (error || !data?.token) {
      setState('error');
      setMessage('Radio session could not be started');
      return;
    }
    const signalUrls = Array.isArray(data.signalUrls)
      ? (data.signalUrls as unknown[]).filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
      : [typeof data.signalUrl === 'string' ? data.signalUrl.trim() : env.pttSignalUrl.trim()].filter(Boolean);
    if (!signalUrls.length) {
      setState('error');
      setMessage('Radio signaling is not configured');
      return;
    }
    iceServersRef.current = Array.isArray(data.iceServers) ? data.iceServers : [];
    let endpointIndex = 0;
    const openSocket = () => {
      const socket = new WebSocket(signalUrls[endpointIndex]);
      socketRef.current = socket;
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: data.token })));
      socket.addEventListener('message', event => {
        const packet = JSON.parse(String(event.data));
      if (packet.type === 'authed') {
        clientIdRef.current = packet.clientId;
        socket.send(JSON.stringify({ type: 'join' }));
      }
      if (packet.type === 'channel_state') {
        joinedRef.current = true;
        setState('ready');
        setMessage(`${packet.members?.length ?? 1} on ${channels.find(channel => channel.id === channelId)?.name ?? 'radio'}`);
        for (const member of packet.members ?? []) {
          if (!member?.clientId || member.clientId === clientIdRef.current || clientIdRef.current! > member.clientId) continue;
          const peer = createPeer(member.clientId);
          void peer.createOffer().then(offer => peer.setLocalDescription(offer).then(() => sendSignal(member.clientId, offer)));
        }
      }
      if (packet.type === 'signal' && typeof packet.from === 'string' && packet.data) {
        const peer = createPeer(packet.from);
        const data = packet.data as RTCSessionDescriptionInit & RTCIceCandidateInit;
        if (data.type === 'offer' && data.sdp) {
          void peer.setRemoteDescription(data).then(() => peer.createAnswer()).then(answer => peer.setLocalDescription(answer).then(() => sendSignal(packet.from, answer)));
        } else if (data.type === 'answer' && data.sdp) {
          void peer.setRemoteDescription(data);
        } else if (data.candidate) {
          void peer.addIceCandidate(data);
        }
      }
      if (packet.type === 'floor_granted') {
        const granted = packet.clientId === clientIdRef.current;
        if (granted) {
          void beginTransmission();
        }
      }
      if (packet.type === 'floor_denied') {
        setState('ready');
        setMessage('Channel is in use');
      }
      if (packet.type === 'floor_released') {
        void endTransmission();
      }
      });
      socket.addEventListener('close', () => {
        const wasJoined = joinedRef.current;
        joinedRef.current = false;
        if (socketRef.current !== socket) return;
        if (!wasJoined && endpointIndex + 1 < signalUrls.length) {
          endpointIndex += 1;
          openSocket();
          return;
        }
        setState('offline');
        setMessage('Radio offline');
      });
      socket.addEventListener('error', () => undefined);
    };
    openSocket();
  };

  const transmit = (active: boolean) => {
    if (!joinedRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: active ? 'floor_request' : 'floor_release' }));
    if (!active) {
      void endTransmission();
    }
  };

  const canConnect = state === 'offline' || state === 'error';
  const canTransmit = state === 'ready' || state === 'transmitting';
  return (
    <aside className={`ptt-bar ptt-${state}`} aria-label="Push to talk radio">
      <Radio size={18} aria-hidden="true" />
      <div className="ptt-bar-status"><strong>Radio</strong><span>{message}</span></div>
      {channels.length > 1 && (
        <select value={channelId} onChange={event => { setChannelId(event.target.value); setState('offline'); setMessage('Radio offline'); }} aria-label="Radio channel">
          {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
      )}
      {canConnect && <button type="button" className="ptt-connect" onClick={() => void connect()}><Radio size={16} aria-hidden="true" /><span>Connect</span></button>}
      {canTransmit && (
        <button
          type="button"
          className="ptt-transmit"
          onPointerDown={() => transmit(true)}
          onPointerUp={() => transmit(false)}
          onPointerLeave={() => transmit(false)}
          onPointerCancel={() => transmit(false)}
          aria-pressed={state === 'transmitting'}
        >
          {state === 'transmitting' ? <VolumeX size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
          <span>{state === 'transmitting' ? 'Release' : 'Hold to talk'}</span>
        </button>
      )}
    </aside>
  );
}