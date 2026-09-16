import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, VideoOff } from 'lucide-react';
import { clipAtTime, formatClock, nextClipAfter, type ConsoleClip } from '../lib/cctvConsole';

type CCTVPlayerTileProps = {
  label: string;
  placeLabel: string | null;
  clips: ConsoleClip[];
  clockMs: number;
  playing: boolean;
  rate: number;
  muted: boolean;
  isMaster: boolean;
  active: boolean;
  timeZone: string;
  resolveUrl: (clip: ConsoleClip) => Promise<string | null>;
  onTick: (ms: number) => void;
  onClipEnded: (clip: ConsoleClip) => void;
  onDurationKnown: (evidenceId: string, durationMs: number) => void;
  onActivate: () => void;
  onRemove?: () => void;
};

const DRIFT_TOLERANCE_SECONDS = 0.75;

/**
 * One camera in the grid. The tile shows whichever clip of its camera covers the shared clock and switches
 * clips as the clock crosses ring-slot boundaries. The master tile's playback drives the clock; every
 * other tile seeks to it, so all cameras stay on the same instant.
 */
export const CCTVPlayerTile: React.FC<CCTVPlayerTileProps> = ({ label, placeLabel, clips, clockMs, playing, rate, muted, isMaster, active, timeZone, resolveUrl, onTick, onClipEnded, onDurationKnown, onActivate, onRemove }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [clip, setClip] = useState<ConsoleClip | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const openingRef = useRef<string | null>(null);

  const targetClip = clipAtTime(clips, clockMs);
  const converting = Boolean(targetClip && !targetClip.playbackPath && /^video\/h26[45]$/.test(targetClip.fileType));

  // Keyed on the clip id held in a ref, not on state, so the re-render caused by setClip does not cancel
  // the signed-URL request that was just started for that same clip.
  useEffect(() => {
    const nextId = targetClip && !converting ? targetClip.evidenceId : null;
    if (nextId === openingRef.current && (nextId !== null || clip === null)) {
      // Same clip, corrected bounds (duration learned from the file): keep the state copy current.
      if (targetClip && clip && targetClip !== clip && targetClip.evidenceId === clip.evidenceId) setClip(targetClip);
      return;
    }
    openingRef.current = nextId;
    setClip(targetClip);
    setSrc(null);
    setError(null);
    if (!targetClip || converting) { setLoading(false); return; }
    setLoading(true);
    resolveUrl(targetClip)
      .then((url) => {
        if (openingRef.current !== nextId) return;
        setSrc(url);
        if (!url) setError('The video could not be opened.');
      })
      .catch((cause) => { if (openingRef.current === nextId) setError(cause instanceof Error ? cause.message : 'The video could not be opened.'); })
      .finally(() => { if (openingRef.current === nextId) setLoading(false); });
  }, [targetClip, clip, converting, resolveUrl]);

  const seekToClock = useCallback((force = false) => {
    const video = videoRef.current;
    if (!video || !clip || !Number.isFinite(video.duration)) return;
    const target = Math.max(0, (clockMs - clip.startMs) / 1000);
    if (target > video.duration) return;
    if (force || Math.abs(video.currentTime - target) > DRIFT_TOLERANCE_SECONDS) video.currentTime = target;
  }, [clip, clockMs]);

  // Followers chase the shared clock. The master's own ticks never drift past the tolerance, so this only
  // moves it when the clock was set from outside (scrub, pin click, keyboard).
  useEffect(() => { seekToClock(false); }, [seekToClock]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    video.muted = muted;
  }, [rate, muted, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (playing) {
      void video.play().catch(() => { /* autoplay blocked until the user interacts; the play button retries */ });
    } else {
      video.pause();
    }
  }, [playing, src]);

  useEffect(() => {
    if (!isMaster || !playing || !src) return;
    const step = () => {
      const video = videoRef.current;
      if (video && clip && !video.paused && !video.seeking) onTick(clip.startMs + video.currentTime * 1000);
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [isMaster, playing, src, clip, onTick]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || !clip) return;
    if (Number.isFinite(video.duration) && video.duration > 0) onDurationKnown(clip.evidenceId, video.duration * 1000);
    seekToClock(true);
    video.playbackRate = rate;
    video.muted = muted;
    if (playing) void video.play().catch(() => undefined);
  };

  const nextClip = !targetClip ? nextClipAfter(clips, clockMs) : null;

  return (
    <div className={`cctv-tile${active ? ' is-active' : ''}${isMaster ? ' is-master' : ''}`} onClick={onActivate} role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onActivate(); }} aria-label={`${label} camera view`} aria-pressed={active}>
      <div className="cctv-tile__header">
        <span className="cctv-tile__label">{label}</span>
        {placeLabel ? <span className="cctv-tile__place">{placeLabel}</span> : null}
        {isMaster ? <span className="cctv-tile__badge">clock</span> : null}
        {onRemove ? <button type="button" className="cctv-tile__remove" onClick={(event) => { event.stopPropagation(); onRemove(); }} aria-label={`Remove ${label} from the view`}>×</button> : null}
      </div>
      <div className="cctv-tile__body">
        {targetClip && !converting ? (
          <video ref={videoRef} src={src ?? undefined} className="cctv-tile__video" playsInline preload="auto"
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => { if (isMaster && clip) onClipEnded(clip); }}
            onError={() => setError('This clip could not be played in the browser.')} />
        ) : null}
        {loading ? <div className="cctv-tile__overlay"><Loader2 size={20} className="spin" aria-hidden="true" /> Opening clip…</div> : null}
        {converting ? <div className="cctv-tile__overlay"><Loader2 size={20} className="spin" aria-hidden="true" /> Converting this clip for playback…</div> : null}
        {error ? <div className="cctv-tile__overlay is-error"><VideoOff size={20} aria-hidden="true" /> {error}</div> : null}
        {!targetClip ? (
          <div className="cctv-tile__overlay">
            <VideoOff size={22} aria-hidden="true" />
            <span>No footage at {formatClock(clockMs, timeZone)}</span>
            {nextClip ? <small>Next clip starts {formatClock(nextClip.startMs, timeZone)}</small> : <small>Nothing later from this camera</small>}
          </div>
        ) : null}
        {targetClip ? <span className="cctv-tile__clip">{targetClip.fileName}</span> : null}
      </div>
    </div>
  );
};

export default CCTVPlayerTile;
