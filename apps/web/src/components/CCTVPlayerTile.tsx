import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Loader2, Sparkles, VideoOff } from 'lucide-react';
import { clipAtTime, formatClock, nextClipAfter, type CCTVInspection, type ConsoleClip } from '../lib/cctvConsole';
import { analyseFramePixels, cssFilterFor, estimateNoiseFloor, panBy, planEnhancement, roiFor, zoomAt, type EnhancementPlan, type ZoomState } from '../lib/cctvEnhance';
import { createEnhancementRenderer, type EnhancementRenderer } from '../lib/cctvEnhanceRenderer';

export type TileSnapshot = { blob: Blob; width: number; height: number; atMs: number; enhanced: boolean };

export type CCTVPlayerTileHandle = {
  /** Move one frame (≈ 1/25 s) in either direction while paused; returns the new instant. */
  stepFrame: (direction: 1 | -1) => number | null;
  /** Rasterise the picture currently on screen (enhanced view when active) for a still export. */
  captureFrame: () => Promise<TileSnapshot | null>;
  currentMs: () => number | null;
  /** Align this clip to a relative playback position without changing its recorded clock. */
  syncTo: (seconds: number) => void;
};

type CCTVPlayerTileProps = {
  label: string;
  placeLabel: string | null;
  clips: ConsoleClip[];
  clockMs: number;
  /** Changes on every deliberate seek; a pinned recording follows those, never the clock's ordinary ticking. */
  seekNonce?: number;
  playing: boolean;
  rate: number;
  muted: boolean;
  isMaster: boolean;
  active: boolean;
  timeZone: string;
  /** When set, the tile plays only this recording on its own clock instead of following the shared clock. */
  pinnedClip?: ConsoleClip | null;
  resolveUrl: (clip: ConsoleClip) => Promise<string | null>;
  onTick: (ms: number) => void;
  onClipEnded: (clip: ConsoleClip) => void;
  onDurationKnown: (evidenceId: string, durationMs: number) => void;
  onActivate: () => void;
  inspection?: CCTVInspection;
  onInspectionChange?: (change: Partial<CCTVInspection>) => void;
  onEnhancementPlan?: (plan: EnhancementPlan | null, mode: 'gpu' | 'css') => void;
  onRemove?: () => void;
};

const DRIFT_TOLERANCE_SECONDS = 0.75;
const FRAME_STEP_SECONDS = 1 / 25;
const ANALYSIS_WIDTH = 96;
const NOISE_PATCH = 128;
const ANALYSIS_INTERVAL_MS = 120;
const PLAN_SMOOTHING = 0.3;

type VideoFrameCapable = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * One tile in the grid. In camera mode it shows whichever clip of its camera covers the shared clock and
 * switches clips as the clock crosses ring-slot boundaries; the master tile's playback drives the clock and
 * every other tile seeks to it. In pinned mode it plays exactly one recording on its own clock, independent
 * of the wall, so a reviewer can open several recordings side by side; it still answers deliberate seeks that
 * land inside its recording, and when it is the active recording its playback drives the timeline.
 */
export const CCTVPlayerTile = React.forwardRef<CCTVPlayerTileHandle, CCTVPlayerTileProps>(function CCTVPlayerTile({ label, placeLabel, clips, clockMs, seekNonce = 0, playing, rate, muted, isMaster, active, timeZone, pinnedClip = null, resolveUrl, onTick, onClipEnded, onDurationKnown, onActivate, inspection, onInspectionChange, onEnhancementPlan, onRemove }, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<EnhancementRenderer | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const planRef = useRef<EnhancementPlan | null>(null);
  const lastAnalysisRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const [clip, setClip] = useState<ConsoleClip | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpuUnavailable, setGpuUnavailable] = useState<string | null>(null);
  const [cssFilter, setCssFilter] = useState<string | null>(null);
  const [localMs, setLocalMs] = useState<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const openingRef = useRef<string | null>(null);

  const enhanceRequested = Boolean(inspection && inspection.enhance !== 'off' && (inspection.enhance === 'on' || inspection.zoom > 1));
  const gpuActive = enhanceRequested && !gpuUnavailable;

  const pinned = Boolean(pinnedClip);
  const targetClip = pinnedClip ?? clipAtTime(clips, clockMs);
  const effectivePlaying = playing;
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
    const offset = (clockMs - clip.startMs) / 1000;
    // A recording on its own clock only moves when the instant lies inside it; the wall never drags it elsewhere.
    if (pinned && (offset < 0 || offset > video.duration)) return;
    const target = Math.max(0, offset);
    if (target > video.duration) return;
    if (force || Math.abs(video.currentTime - target) > DRIFT_TOLERANCE_SECONDS) {
      video.currentTime = target;
      if (pinned) setLocalMs(clip.startMs + target * 1000);
    }
  }, [clip, clockMs, pinned]);

  // Followers chase the shared clock. The master's own ticks never drift past the tolerance, so this only
  // moves it when the clock was set from outside (scrub, pin click, keyboard). Pinned recordings respond only
  // to those deliberate seeks, so two synced recordings are never pulled apart by the clock ticking.
  const seenSeekNonce = useRef(seekNonce);
  useEffect(() => {
    if (!pinned) { seekToClock(false); return; }
    if (seenSeekNonce.current === seekNonce) return;
    seenSeekNonce.current = seekNonce;
    seekToClock(true);
  }, [seekToClock, seekNonce, pinned]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    video.muted = muted;
  }, [rate, muted, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (effectivePlaying) {
      void video.play().catch(() => { /* autoplay blocked until the user interacts; the play button retries */ });
    } else {
      video.pause();
    }
  }, [effectivePlaying, src]);

  useEffect(() => {
    if ((!isMaster && !pinned) || !effectivePlaying || !src) return;
    const step = () => {
      const video = videoRef.current;
      if (video && clip && !video.paused && !video.seeking) {
        const at = clip.startMs + video.currentTime * 1000;
        if (pinned) setLocalMs(at);
        if (isMaster) onTick(at);
      }
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [isMaster, pinned, effectivePlaying, src, clip, onTick]);

  useEffect(() => { setLocalMs(pinnedClip ? pinnedClip.startMs : null); }, [pinnedClip?.evidenceId]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || !clip) return;
    if (Number.isFinite(video.duration) && video.duration > 0) onDurationKnown(clip.evidenceId, video.duration * 1000);
    seekToClock(true);
    video.playbackRate = rate;
    video.muted = muted;
    if (effectivePlaying) void video.play().catch(() => undefined);
  };

  useImperativeHandle(ref, () => ({
    stepFrame: (direction) => {
      const video = videoRef.current;
      if (!video || !clip || !Number.isFinite(video.duration)) return null;
      video.pause();
      const next = Math.min(video.duration, Math.max(0, video.currentTime + direction * FRAME_STEP_SECONDS));
      video.currentTime = next;
      const at = clip.startMs + next * 1000;
      if (pinned) setLocalMs(at);
      if (isMaster) onTick(at);
      return at;
    },
    captureFrame: async () => {
      const video = videoRef.current;
      if (!video || !clip || video.readyState < 2) return null;
      const source: HTMLCanvasElement | HTMLVideoElement = gpuActive && canvasRef.current ? canvasRef.current : video;
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      try {
        context.drawImage(source, 0, 0, width, height);
      } catch {
        return null;
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob ? { blob, width, height, atMs: clip.startMs + video.currentTime * 1000, enhanced: gpuActive } : null;
    },
    currentMs: () => {
      const video = videoRef.current;
      return video && clip ? clip.startMs + video.currentTime * 1000 : null;
    },
    syncTo: (seconds) => {
      const video = videoRef.current;
      if (!video || !clip || !Number.isFinite(video.duration)) return;
      const next = Math.min(video.duration, Math.max(0, seconds));
      video.currentTime = next;
      const at = clip.startMs + next * 1000;
      if (pinned) setLocalMs(at);
      if (isMaster) onTick(at);
    },
  }), [clip, pinned, isMaster, gpuActive, onTick]);

  const nextClip = !targetClip && !pinned ? nextClipAfter(clips, clockMs) : null;

  // The enhanced view is drawn on a canvas over the video; the picture underneath keeps decoding and
  // remains the untouched source. A clip that cannot be read cross-origin falls back to CSS filters.
  useEffect(() => {
    const canvas = canvasRef.current;
    rendererRef.current?.dispose();
    rendererRef.current = null;
    if (!canvas || !enhanceRequested || gpuUnavailable) return;
    try {
      rendererRef.current = createEnhancementRenderer(canvas);
    } catch {
      rendererRef.current = null;
    }
    if (!rendererRef.current) { setGpuUnavailable('This browser cannot run the enhanced view; showing basic adjustments instead.'); return; }
    return () => { rendererRef.current?.dispose(); rendererRef.current = null; };
  }, [enhanceRequested, gpuUnavailable, src, clip?.evidenceId]);

  useEffect(() => {
    planRef.current = null;
    lastAnalysisRef.current = 0;
  }, [clip?.evidenceId]);

  const renderEnhanced = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!video || !canvas || !inspection || video.readyState < 2 || !video.videoWidth) return;
    const zoomState = { zoom: inspection.zoom, focusX: inspection.focusX, focusY: inspection.focusY };
    const roi = roiFor(zoomState.zoom, zoomState.focusX, zoomState.focusY);
    const now = performance.now();
    if (now - lastAnalysisRef.current >= ANALYSIS_INTERVAL_MS) {
      lastAnalysisRef.current = now;
      const sampler = analysisCanvasRef.current ?? (analysisCanvasRef.current = document.createElement('canvas'));
      const sampleHeight = Math.max(8, Math.round(ANALYSIS_WIDTH * (video.videoHeight / video.videoWidth)));
      sampler.width = ANALYSIS_WIDTH;
      sampler.height = sampleHeight;
      const context = sampler.getContext('2d', { willReadFrequently: true });
      if (context) {
        try {
          // Noise floor from a 1:1 patch at the centre of the visible region; the exposure sample is downscaled.
          const patch = Math.min(NOISE_PATCH, Math.floor(roi.width * video.videoWidth), Math.floor(roi.height * video.videoHeight));
          let noiseFloor: number | null = null;
          if (patch >= 16) {
            sampler.width = patch;
            sampler.height = patch;
            const patchX = (roi.x + roi.width / 2) * video.videoWidth - patch / 2;
            const patchY = (roi.y + roi.height / 2) * video.videoHeight - patch / 2;
            context.drawImage(video, patchX, patchY, patch, patch, 0, 0, patch, patch);
            noiseFloor = estimateNoiseFloor(context.getImageData(0, 0, patch, patch).data, patch, patch);
            sampler.width = ANALYSIS_WIDTH;
            sampler.height = sampleHeight;
          }
          context.drawImage(video, roi.x * video.videoWidth, roi.y * video.videoHeight, roi.width * video.videoWidth, roi.height * video.videoHeight, 0, 0, ANALYSIS_WIDTH, sampleHeight);
          const stats = analyseFramePixels(context.getImageData(0, 0, ANALYSIS_WIDTH, sampleHeight).data, ANALYSIS_WIDTH, sampleHeight, noiseFloor);
          planRef.current = planEnhancement(stats, { zoom: zoomState.zoom, previous: planRef.current, smoothing: planRef.current ? PLAN_SMOOTHING : 1 });
        } catch {
          setGpuUnavailable('This clip cannot be read for enhancement in the browser; showing basic adjustments instead.');
          return;
        }
      }
      onEnhancementPlan?.(planRef.current, renderer && !gpuUnavailable ? 'gpu' : 'css');
    }
    const plan = planRef.current ?? planEnhancement(null, { zoom: zoomState.zoom, smoothing: 1 });
    const manual = { brightness: inspection.brightness, contrast: inspection.contrast, saturation: inspection.saturation, detail: inspection.detail };
    if (!renderer || gpuUnavailable) { setCssFilter(cssFilterFor(plan, manual)); return; }
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ok = renderer.render(video, { plan, manual, roi, sourceWidth: video.videoWidth, sourceHeight: video.videoHeight });
    if (!ok) setGpuUnavailable(renderer.isLost() ? 'The graphics context was lost; showing basic adjustments instead.' : 'This clip cannot be read for enhancement in the browser; showing basic adjustments instead.');
  }, [inspection, gpuUnavailable, onEnhancementPlan]);

  // Frame loop: every decoded frame while playing, one render per change while paused.
  useEffect(() => {
    const video = videoRef.current as VideoFrameCapable | null;
    if (!video || !src || !enhanceRequested) { setCssFilter(null); return; }
    let cancelled = false;
    let handle: number | null = null;
    const usesVideoFrames = typeof video.requestVideoFrameCallback === 'function';
    const step = () => {
      if (cancelled) return;
      renderEnhanced();
      if (!playing && !usesVideoFrames) return;
      handle = usesVideoFrames ? video.requestVideoFrameCallback!(step) : requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelled = true;
      if (handle !== null) {
        if (usesVideoFrames) video.cancelVideoFrameCallback?.(handle);
        else cancelAnimationFrame(handle);
      }
    };
  }, [src, enhanceRequested, playing, renderEnhanced, clockMs]);

  useEffect(() => { setGpuUnavailable(null); }, [clip?.evidenceId]);

  const pointIn = (element: HTMLElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: Math.min(100, Math.max(0, ((clientX - bounds.left) / bounds.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - bounds.top) / bounds.height) * 100)),
      width: bounds.width,
      height: bounds.height,
    };
  };
  const pointFor = (event: React.PointerEvent) => pointIn(event.currentTarget as HTMLElement, event.clientX, event.clientY);

  const zoomState: ZoomState | null = inspection ? { zoom: inspection.zoom, focusX: inspection.focusX, focusY: inspection.focusY } : null;
  const latestRef = useRef({ zoomState, onInspectionChange });
  latestRef.current = { zoomState, onInspectionChange };

  // React registers onWheel as passive, so preventDefault there cannot stop the page scrolling; bind natively.
  const wheelEnabled = Boolean(inspection && onInspectionChange && targetClip && !converting);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || !wheelEnabled) return;
    const handler = (event: WheelEvent) => {
      const { zoomState: state, onInspectionChange: change } = latestRef.current;
      if (!state || !change) return;
      const point = pointIn(element, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
      const next = zoomAt(state, Math.round(state.zoom * factor * 100) / 100, point.x, point.y);
      change({ zoom: next.zoom, focusX: next.focusX, focusY: next.focusY });
    };
    element.addEventListener('wheel', handler, { passive: false });
    return () => element.removeEventListener('wheel', handler);
  }, [wheelEnabled]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomState || !onInspectionChange || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !zoomState || !onInspectionChange || zoomState.zoom <= 1) return;
    const point = pointFor(event);
    if (!point) return;
    const deltaX = (event.clientX - drag.x) / point.width;
    const deltaY = (event.clientY - drag.y) / point.height;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
    drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const next = panBy(zoomState, deltaX, deltaY);
    onInspectionChange({ focusX: next.focusX, focusY: next.focusY });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId || !zoomState || !onInspectionChange) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) return;
    // A plain click re-centres the zoom on that point; at 1x it only records the focus for the next zoom.
    const point = pointFor(event);
    if (!point) return;
    if (zoomState.zoom > 1) {
      const next = zoomAt(zoomState, zoomState.zoom, point.x, point.y);
      onInspectionChange({ focusX: next.focusX, focusY: next.focusY });
    } else {
      onInspectionChange({ focusX: point.x, focusY: point.y });
    }
  };

  const videoStyle = inspection && !gpuActive
    ? {
      filter: enhanceRequested && cssFilter ? cssFilter : `brightness(${inspection.brightness}%) contrast(${inspection.contrast}%) saturate(${inspection.saturation}%)`,
      transform: `scale(${inspection.zoom})`,
      transformOrigin: `${inspection.focusX}% ${inspection.focusY}%`,
    }
    : undefined;

  return (
    <div className={`cctv-tile${active ? ' is-active' : ''}${isMaster && !pinned ? ' is-master' : ''}${pinned ? ' is-pinned' : ''}`} onClick={onActivate} role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onActivate(); }} aria-label={pinned && pinnedClip ? `${label} recording ${pinnedClip.fileName}` : `${label} camera view`} aria-pressed={active}>
      <div className="cctv-tile__header">
        <span className="cctv-tile__label">{label}</span>
        {placeLabel ? <span className="cctv-tile__place">{placeLabel}</span> : null}
        {pinned ? <span className="cctv-tile__badge is-pinned">own clock</span> : isMaster ? <span className="cctv-tile__badge">clock</span> : null}
        {onRemove ? <button type="button" className="cctv-tile__remove" onClick={(event) => { event.stopPropagation(); onRemove(); }} aria-label={`Remove ${label} from the view`}>×</button> : null}
      </div>
      <div ref={bodyRef} className={`cctv-tile__body${inspection && inspection.zoom > 1 ? ' is-zoomed' : ''}${gpuActive ? ' is-enhanced' : ''}`}
        onPointerDown={inspection ? handlePointerDown : undefined}
        onPointerMove={inspection ? handlePointerMove : undefined} onPointerUp={inspection ? handlePointerUp : undefined} onPointerCancel={() => { dragRef.current = null; }}>
        {targetClip && !converting ? (
          <video ref={videoRef} src={src ?? undefined} className="cctv-tile__video" playsInline preload="auto" crossOrigin="anonymous"
            style={videoStyle}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => { if (!pinned && isMaster && clip) onClipEnded(clip); }}
            onError={() => setError('This clip could not be played in the browser.')} />
        ) : null}
        {targetClip && !converting && enhanceRequested ? <canvas ref={canvasRef} className={`cctv-tile__enhanced${gpuActive ? ' is-live' : ''}`} aria-hidden="true" /> : null}
        {targetClip && !converting && enhanceRequested && inspection ? (
          <span className="cctv-tile__enhance-badge" title={gpuActive ? 'Display-only enhancement of the zoomed picture. The stored recording is unchanged.' : gpuUnavailable ?? ''}>
            <Sparkles size={11} aria-hidden="true" /> {gpuActive ? 'Enhanced view' : 'Basic adjustments'}{inspection.zoom > 1 ? ` · ${inspection.zoom.toFixed(inspection.zoom % 1 ? 2 : 0)}×` : ''}
          </span>
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
        {targetClip ? (
          <div className="cctv-tile__footer">
            <span className="cctv-tile__clip">{targetClip.fileName}</span>
            <span className="cctv-tile__time">{formatClock(pinned ? (localMs ?? targetClip.startMs) : clockMs, timeZone)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default CCTVPlayerTile;
