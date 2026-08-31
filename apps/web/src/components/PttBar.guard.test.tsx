import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, 'PttBar.tsx'), 'utf8');

describe('PttBar operational boundary', () => {
  it('mints an authenticated session and leaves audio disabled until the server grants the floor', () => {
    expect(source).toContain("functions.invoke('ptt-session'");
    expect(source).toContain('data.signalUrl');
    expect(source).toContain('data.signalUrls');
    expect(source).toContain('navigator.mediaDevices.getUserMedia({ audio: true })');
    expect(source).toContain('track.enabled = false');
    expect(source).toContain("packet.type === 'floor_granted'");
    expect(source).toContain('new RTCPeerConnection({ iceServers: iceServersRef.current })');
    expect(source).toContain('iceServers: iceServersRef.current');
    expect(source).toContain("from('ptt_transmissions')");
    expect(source).toContain("state: 'started'");
    expect(source).toContain("state: 'ended'");
    expect(source).not.toContain('PTT_SESSION_SECRET');
  });
});