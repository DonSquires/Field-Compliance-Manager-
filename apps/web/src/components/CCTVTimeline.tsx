import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clusterMarks,
  formatClock,
  ticksFor,
  timeToX,
  xToTime,
  zoomView,
  panView,
  SEVERITY_COLOURS,
  type ConsoleClip,
  type ConsoleMark,
  type ConsoleObservation,
  type TimeView,
} from '../lib/cctvConsole';

type CCTVTimelineProps = {
  view: TimeView;
  bounds: TimeView;
  clockMs: number;
  clips: ConsoleClip[];
  marks: ConsoleMark[];
  observations: ConsoleObservation[];
  selectedObservationId: string | null;
  timeZone: string;
  onSeek: (ms: number) => void;
  onViewChange: (view: TimeView) => void;
  onSelectObservation: (id: string) => void;
};

const HEIGHT = 96;
const LANES = { ticks: 14, clips: 22, marks: 40, quality: 56, pins: 70 };

/**
 * Horizontal severity timeline for one or more cameras: recording coverage, the camera's own motion ticks,
 * inference windows graded alert / detection / motion, camera disturbances, and one pin per entity
 * observation (dimmed once reviewed). Click seeks the shared clock, drag scrubs, wheel zooms around the
 * cursor, shift+wheel pans.
 */
export const CCTVTimeline: React.FC<CCTVTimelineProps> = ({ view, bounds, clockMs, clips, marks, observations, selectedObservationId, timeZone, onSeek, onViewChange, onSelectObservation }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1000);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.max(200, Math.floor(entries[0]?.contentRect.width || 1000));
      setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const timeAt = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return view.startMs;
    return xToTime(clientX - rect.left, view, rect.width);
  }, [view]);

  const clusters = useMemo(() => clusterMarks(marks, view, width), [marks, view, width]);
  const ticks = useMemo(() => ticksFor(view, width), [view, width]);
  const visibleObservations = useMemo(
    () => observations.filter((observation) => observation.observedAtMs >= view.startMs - 5000 && observation.observedAtMs <= view.endMs + 5000),
    [observations, view],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragging.current = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    onSeek(timeAt(event.clientX));
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const ms = timeAt(event.clientX);
    setHover(ms);
    if (dragging.current) onSeek(ms);
  };
  const stopDrag = () => { dragging.current = false; };
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const span = view.endMs - view.startMs;
      onViewChange(panView(view, ((event.deltaX || event.deltaY) / Math.max(1, width)) * span, bounds));
      return;
    }
    onViewChange(zoomView(view, timeAt(event.clientX), event.deltaY > 0 ? 1.25 : 0.8, bounds));
  };

  const playheadX = timeToX(clockMs, view, width);

  return (
    <div className="cctv-timeline" ref={containerRef}
      onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={stopDrag} onPointerLeave={() => { stopDrag(); setHover(null); }}
      onWheel={handleWheel} role="slider" aria-label="Footage timeline" aria-valuemin={bounds.startMs} aria-valuemax={bounds.endMs} aria-valuenow={clockMs}
      aria-valuetext={formatClock(clockMs, timeZone)} tabIndex={-1}>
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x={0} y={0} width={width} height={HEIGHT} className="cctv-timeline__bg" />
        {ticks.map((ms) => {
          const x = timeToX(ms, view, width);
          return (
            <g key={ms}>
              <line x1={x} x2={x} y1={LANES.ticks} y2={HEIGHT} className="cctv-timeline__grid" />
              <text x={x + 3} y={LANES.ticks - 3} className="cctv-timeline__tick-label">{formatClock(ms, timeZone)}</text>
            </g>
          );
        })}
        {clips.filter((clip) => clip.endMs >= view.startMs && clip.startMs <= view.endMs).map((clip) => {
          const x0 = timeToX(clip.startMs, view, width);
          const x1 = timeToX(clip.endMs, view, width);
          return <rect key={clip.evidenceId} x={x0} y={LANES.clips} width={Math.max(1, x1 - x0)} height={10} rx={2} className={`cctv-timeline__clip is-${clip.jobStatus}`}><title>{clip.fileName} · {clip.jobStatus}</title></rect>;
        })}
        {clusters.filter((cluster) => cluster.severity !== 'quality').map((cluster) => (
          <rect key={cluster.id} x={cluster.x0} y={LANES.marks} width={Math.max(2, cluster.x1 - cluster.x0)} height={12} rx={2} fill={SEVERITY_COLOURS[cluster.severity]} opacity={0.9} className={`cctv-timeline__mark is-${cluster.severity}`}>
            <title>{cluster.count > 1 ? `${cluster.count} ${cluster.severity} marks` : cluster.marks[0].label} · {formatClock(cluster.startMs, timeZone)}</title>
          </rect>
        ))}
        {clusters.filter((cluster) => cluster.severity === 'quality').map((cluster) => (
          <rect key={cluster.id} x={cluster.x0} y={LANES.quality} width={Math.max(2, cluster.x1 - cluster.x0)} height={8} rx={1} fill={SEVERITY_COLOURS.quality} opacity={0.75} className="cctv-timeline__mark is-quality">
            <title>{cluster.marks.map((item) => item.label).slice(0, 3).join(', ')}{cluster.count > 3 ? ` +${cluster.count - 3}` : ''} · {formatClock(cluster.startMs, timeZone)}</title>
          </rect>
        ))}
        {visibleObservations.map((observation) => {
          const x = timeToX(observation.observedAtMs, view, width);
          const reviewed = observation.reviewState !== 'unreviewed';
          const selected = observation.id === selectedObservationId;
          const tone = observation.kind === 'vehicle' && observation.plate ? SEVERITY_COLOURS.alert : observation.kind === 'animal' && observation.isPest ? SEVERITY_COLOURS.alert : SEVERITY_COLOURS.detection;
          return (
            <g key={observation.id} className={`cctv-timeline__pin${reviewed ? ' is-reviewed' : ''}${selected ? ' is-selected' : ''}`}
              onPointerDown={(event) => { event.stopPropagation(); onSelectObservation(observation.id); onSeek(observation.observedAtMs); }}>
              <line x1={x} x2={x} y1={LANES.pins} y2={HEIGHT - 4} stroke={tone} strokeWidth={selected ? 3 : 1.5} opacity={reviewed ? 0.45 : 1} />
              <circle cx={x} cy={LANES.pins + 2} r={selected ? 6 : 4.5} fill={tone} opacity={reviewed ? 0.45 : 1} stroke={selected ? '#fff' : 'none'} strokeWidth={2} />
              <title>{observation.kind} · {formatClock(observation.observedAtMs, timeZone)}{reviewed ? ` · ${observation.reviewState}` : ''}</title>
            </g>
          );
        })}
        {hover !== null && hover >= view.startMs && hover <= view.endMs ? (
          <g className="cctv-timeline__hover">
            <line x1={timeToX(hover, view, width)} x2={timeToX(hover, view, width)} y1={LANES.ticks} y2={HEIGHT} />
            <text x={Math.min(width - 64, timeToX(hover, view, width) + 4)} y={HEIGHT - 6}>{formatClock(hover, timeZone)}</text>
          </g>
        ) : null}
        <g className="cctv-timeline__playhead">
          <line x1={playheadX} x2={playheadX} y1={0} y2={HEIGHT} />
          <polygon points={`${playheadX - 6},0 ${playheadX + 6},0 ${playheadX},8`} />
        </g>
      </svg>
    </div>
  );
};

export default CCTVTimeline;
