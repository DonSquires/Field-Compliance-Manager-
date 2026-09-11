export interface BoundingBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ConsolidatedFaceEvent {
  event_id: string;
  event_type: 'face';
  subject_id: number;
  subject_label: string;
  is_return: boolean;
  first_seen_seconds: number;
  last_seen_seconds: number;
  duration_seconds: number;
  frame_count: number;
  visit_count?: number;
  best_frame_hash: string | null;
  best_bbox?: BoundingBox | null;
  thumbnail?: string | null;
  review_state: string;
}

export interface ConsolidatedVehicleEvent {
  event_id: string;
  event_type: 'vehicle';
  plate: string;
  confidence: number;
  is_return: boolean;
  first_seen_seconds: number;
  last_seen_seconds: number;
  duration_seconds: number;
  frame_count: number;
  visit_count?: number;
  best_frame_hash: string | null;
  thumbnail?: string | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_year?: number | null;
  vehicle_colour?: string | null;
  vehicle_type?: string | null;
  vehicle_attribute_confidence?: number | null;
  inference_provider?: string | null;
  speed_px_per_second?: number | null;
  speed_kmh?: number | null;
  speed_calibration?: string | null;
  review_required: boolean;
  temporal_consensus?: boolean;
}

export interface ConsolidatedPersonEvent {
  event_id: string;
  event_type: 'person';
  first_seen_seconds: number;
  last_seen_seconds: number;
  duration_seconds: number;
  frame_count: number;
  visit_count?: number;
  confidence: number;
  best_frame_hash: string | null;
  best_bbox?: BoundingBox | null;
  thumbnail?: string | null;
  review_required: boolean;
  attributes?: Record<string, unknown> | null;
}

export interface ConsolidatedAnimalEvent {
  event_id: string;
  event_type: 'animal';
  animal_type?: string | null;
  first_seen_seconds: number;
  last_seen_seconds: number;
  confidence: number;
  best_frame_hash: string | null;
  thumbnail?: string | null;
  review_required: boolean;
}

export interface KeyframeItem {
  frame_index: number;
  timestamp_seconds: number;
  sha256_hash: string;
  thumbnail?: string | null;
}

export interface ConsolidatedResult {
  vehicle_events: ConsolidatedVehicleEvent[];
  person_events: ConsolidatedPersonEvent[];
  face_events: ConsolidatedFaceEvent[];
  animal_events?: ConsolidatedAnimalEvent[];
  keyframes: KeyframeItem[];
  summary_counts: {
    vehicle_events: number;
    person_events: number;
    unique_vehicles: number;
    face_events: number;
    unique_faces: number;
    total_frames_with_motion: number;
    total_frames_parsed: number;
  };
  quality_summary?: {
    review_required_count?: number;
    single_frame_vehicle_count?: number;
    provider_counts?: Record<string, number>;
    animal_detection_status?: string;
    policy?: string;
  };
}

export function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = Number(a[i]) || 0;
    const valB = Number(b[i]) || 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function averageEmbedding(existingAvg: number[], count: number, newEmbedding: number[]): number[] {
  if (!existingAvg || !existingAvg.length) return [...newEmbedding];
  const updated = new Array(existingAvg.length);
  for (let i = 0; i < existingAvg.length; i++) {
    updated[i] = (existingAvg[i] * (count - 1) + newEmbedding[i]) / count;
  }
  return updated;
}

function isPlatish(plate: string | undefined, confidence: number): boolean {
  if (!plate || typeof plate !== 'string') return false;
  const clean = plate.trim().toUpperCase();
  if (clean.length < 2 || clean.length > 8) return false;
  if (clean.length === 2 && confidence < 0.75) return false;
  if (/^\d{1,2}$/.test(clean)) return false;
  return true;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function consolidateResultData(
  resultData: Record<string, unknown> | undefined,
  options: { faceSimilarityThreshold?: number; maxGapSeconds?: number; keyframeCount?: number } = {}
): ConsolidatedResult {
  // If resultData already has consolidated_events from the watcher, return it directly
  if (
    resultData?.consolidated_events &&
    typeof resultData.consolidated_events === 'object' &&
    Array.isArray((resultData.consolidated_events as Record<string, unknown>).face_events)
  ) {
    const raw = resultData.consolidated_events as unknown as ConsolidatedResult;
    return {
      vehicle_events: raw.vehicle_events || [],
      person_events: raw.person_events || [],
      face_events: raw.face_events || [],
      animal_events: raw.animal_events || [],
      keyframes: raw.keyframes || [],
      summary_counts: raw.summary_counts || {
        vehicle_events: (raw.vehicle_events || []).length,
        person_events: (raw.person_events || []).length,
        unique_vehicles: (raw.vehicle_events || []).length,
        face_events: (raw.face_events || []).length,
        unique_faces: (raw.face_events || []).length,
        total_frames_with_motion: 0,
        total_frames_parsed: Number(resultData.total_frames_parsed) || 0,
      },
      quality_summary: raw.quality_summary,
    };
  }

  const simThreshold = options.faceSimilarityThreshold ?? 0.65;
  const maxGap = options.maxGapSeconds ?? 15.0;
  const keyframeCount = options.keyframeCount ?? 6;

  const rawSegments = Array.isArray(resultData?.motion_segments) ? resultData.motion_segments : [];
  interface RawFrame {
    frame_index?: number;
    relative_timestamp_seconds?: number;
    sha256_hash?: string;
    file_path?: string;
    thumbnail?: string;
    alpr?: { success?: boolean; plate?: string; confidence?: number };
    face?: { success?: boolean; faces?: Array<{ embedding?: number[]; bbox?: BoundingBox; subject_label?: string }> };
  }

  const allFrames: RawFrame[] = rawSegments.flatMap((s: unknown) =>
    s && typeof s === 'object' && Array.isArray((s as Record<string, unknown>).frames)
      ? ((s as Record<string, unknown>).frames as RawFrame[])
      : []
  );

  // 1. Consolidate Faces
  interface FaceTrack {
    subjectId: number;
    subjectLabel: string;
    isReturn: boolean;
    firstSeen: number;
    lastSeen: number;
    frameCount: number;
    bestFrame: RawFrame | null;
    bestBbox: BoundingBox | null;
    bestBboxArea: number;
  }

  interface FaceSubject {
    subjectId: number;
    subjectLabel: string;
    avgEmbedding: number[];
    totalSightings: number;
    completedTracks: FaceTrack[];
    activeTrack: FaceTrack | null;
  }

  const subjects: FaceSubject[] = [];
  let nextSubjectId = 1;

  for (const frame of allFrames) {
    if (!frame?.face?.success || !Array.isArray(frame.face.faces)) continue;
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;

    for (const detectedFace of frame.face.faces) {
      const embedding = Array.isArray(detectedFace.embedding) ? detectedFace.embedding : null;
      if (!embedding || embedding.length === 0) continue;

      let bestSubject: FaceSubject | null = null;
      let highestSim = -1;

      for (const subj of subjects) {
        const sim = cosineSimilarity(embedding, subj.avgEmbedding);
        if (sim > highestSim) {
          highestSim = sim;
          bestSubject = subj;
        }
      }

      if (bestSubject && highestSim >= simThreshold) {
        bestSubject.totalSightings++;
        bestSubject.avgEmbedding = averageEmbedding(bestSubject.avgEmbedding, bestSubject.totalSightings, embedding);

        const track = bestSubject.activeTrack;
        if (track && timestamp - track.lastSeen <= maxGap) {
          track.lastSeen = timestamp;
          track.frameCount++;
          const bbox = detectedFace.bbox || null;
          const bboxArea = bbox ? (bbox.width || 0) * (bbox.height || 0) : 0;
          if (bboxArea > track.bestBboxArea) {
            track.bestBboxArea = bboxArea;
            track.bestFrame = frame;
            track.bestBbox = bbox;
          }
        } else {
          if (track) bestSubject.completedTracks.push(track);
          const bbox = detectedFace.bbox || null;
          bestSubject.activeTrack = {
            subjectId: bestSubject.subjectId,
            subjectLabel: bestSubject.subjectLabel,
            isReturn: bestSubject.completedTracks.length > 0,
            firstSeen: timestamp,
            lastSeen: timestamp,
            frameCount: 1,
            bestFrame: frame,
            bestBbox: bbox,
            bestBboxArea: bbox ? (bbox.width || 0) * (bbox.height || 0) : 0,
          };
        }
      } else {
        const subjectId = nextSubjectId++;
        const subjectLabel = `Person #${subjectId}`;
        const bbox = detectedFace.bbox || null;
        subjects.push({
          subjectId,
          subjectLabel,
          avgEmbedding: [...embedding],
          totalSightings: 1,
          completedTracks: [],
          activeTrack: {
            subjectId,
            subjectLabel,
            isReturn: false,
            firstSeen: timestamp,
            lastSeen: timestamp,
            frameCount: 1,
            bestFrame: frame,
            bestBbox: bbox,
            bestBboxArea: bbox ? (bbox.width || 0) * (bbox.height || 0) : 0,
          },
        });
      }
    }
  }

  const allFaceTracks: FaceTrack[] = [];
  for (const subj of subjects) {
    if (subj.activeTrack) subj.completedTracks.push(subj.activeTrack);
    allFaceTracks.push(...subj.completedTracks);
  }
  allFaceTracks.sort((a, b) => a.firstSeen - b.firstSeen);

  const face_events: ConsolidatedFaceEvent[] = allFaceTracks.map((tr, idx) => ({
    event_id: `face-${tr.subjectId}-${idx + 1}`,
    event_type: 'face',
    subject_id: tr.subjectId,
    subject_label: tr.isReturn ? `${tr.subjectLabel} (Return)` : tr.subjectLabel,
    is_return: tr.isReturn,
    first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
    last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
    duration_seconds: Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2))),
    frame_count: tr.frameCount,
    best_frame_hash: tr.bestFrame?.sha256_hash || null,
    best_bbox: tr.bestBbox,
    thumbnail: tr.bestFrame?.thumbnail || null,
    review_state: 'manual_review_required',
  }));

  // 2. Consolidate Vehicles
  interface VehicleTrack {
    isReturn: boolean;
    firstSeen: number;
    lastSeen: number;
    frameCount: number;
    bestConfidence: number;
    bestPlate: string;
    bestFrame: RawFrame | null;
  }
  const vehicleGroups: Array<{ plate: string; tracks: VehicleTrack[] }> = [];

  for (const frame of allFrames) {
    if (!frame?.alpr?.success || !frame.alpr.plate?.trim()) continue;
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    const plate = frame.alpr.plate.trim().toUpperCase();
    const confidence = Number(frame.alpr.confidence) || 0;
    if (!isPlatish(plate, confidence)) continue;

    let group = vehicleGroups.find((g) => {
      if (g.plate === plate) return true;
      if (g.plate.length >= 4 && plate.length >= 4 && levenshteinDistance(g.plate, plate) <= 1) return true;
      return false;
    });

    if (!group) {
      group = { plate, tracks: [] };
      vehicleGroups.push(group);
    }

    const currentTrack = group.tracks[group.tracks.length - 1];
    if (currentTrack && timestamp - currentTrack.lastSeen <= maxGap) {
      currentTrack.lastSeen = timestamp;
      currentTrack.frameCount++;
      if (confidence >= currentTrack.bestConfidence || (plate.length > currentTrack.bestPlate.length && confidence >= 0.6)) {
        currentTrack.bestConfidence = Math.max(currentTrack.bestConfidence, confidence);
        currentTrack.bestPlate = plate.length >= currentTrack.bestPlate.length ? plate : currentTrack.bestPlate;
        currentTrack.bestFrame = frame;
      }
    } else {
      group.tracks.push({
        isReturn: group.tracks.length > 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        frameCount: 1,
        bestConfidence: confidence,
        bestPlate: plate,
        bestFrame: frame,
      });
    }
  }

  const allVehicleTracks: Array<VehicleTrack & { groupPlate: string; trackIndex: number }> = [];
  for (const group of vehicleGroups) {
    for (let i = 0; i < group.tracks.length; i++) {
      allVehicleTracks.push({ ...group.tracks[i], groupPlate: group.plate, trackIndex: i + 1 });
    }
  }
  allVehicleTracks.sort((a, b) => a.firstSeen - b.firstSeen);

  const vehicle_events: ConsolidatedVehicleEvent[] = allVehicleTracks.map((tr) => ({
    event_id: `vehicle-${tr.bestPlate}-${tr.trackIndex}`,
    event_type: 'vehicle',
    plate: tr.bestPlate,
    confidence: Number(tr.bestConfidence.toFixed(2)),
    is_return: tr.isReturn,
    first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
    last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
    duration_seconds: Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2))),
    frame_count: tr.frameCount,
    best_frame_hash: tr.bestFrame?.sha256_hash || null,
    thumbnail: tr.bestFrame?.thumbnail || null,
    review_required: true,
  }));

  // 3. Extract Keyframes
  const keyframes: KeyframeItem[] = [];
  if (allFrames.length > 0) {
    const step = Math.max(1, Math.floor(allFrames.length / keyframeCount));
    for (let i = 0; i < allFrames.length && keyframes.length < keyframeCount; i += step) {
      const f = allFrames[i];
      keyframes.push({
        frame_index: f.frame_index ?? i,
        timestamp_seconds: Number((Number(f.relative_timestamp_seconds) || 0).toFixed(2)),
        sha256_hash: f.sha256_hash || `frame-${i}`,
        thumbnail: f.thumbnail || null,
      });
    }
  }

  return {
    vehicle_events,
    person_events: (resultData?.person_events || []) as ConsolidatedPersonEvent[],
    face_events,
    animal_events: [],
    keyframes,
    summary_counts: {
      vehicle_events: vehicle_events.length,
      person_events: Array.isArray(resultData?.person_events) ? resultData.person_events.length : 0,
      unique_vehicles: vehicleGroups.length,
      face_events: face_events.length,
      unique_faces: subjects.length,
      total_frames_with_motion: allFrames.length,
      total_frames_parsed: Number(resultData?.total_frames_parsed) || allFrames.length,
    },
  };
}
