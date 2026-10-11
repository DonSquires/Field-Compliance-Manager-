import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

type JsonRecord = Record<string, unknown>;

export type RecognitionCandidate = {
  candidate_id: string;
  entity_kind: 'person' | 'vehicle';
  match_kind: string;
  display_name: string;
  score: number;
  basis: string;
  person_record_id: string | null;
  canonical_vehicle_id: string | null;
  plate_number: string | null;
  reference_thumbnail: string | null;
  last_seen_at: string | null;
};

export type RecognitionProbe = {
  probe_id: string;
  probe_kind: 'face' | 'person' | 'vehicle' | 'plate';
  source_variant: 'source' | 'enhanced';
  detector_confidence: number | null;
  bbox: JsonRecord | null;
  plate_number: string | null;
  plate_confidence: number | null;
  attributes: JsonRecord;
  candidates: RecognitionCandidate[];
};

export type AccessRecognitionReceipt = {
  status: 'available' | 'unavailable';
  classification: string | null;
  confidence: number | null;
  details: {
    subject_kind: 'person' | 'vehicle' | 'mixed' | 'unknown';
    person_present: boolean;
    face_visible: boolean;
    credential_visible: null;
    vehicle_present: boolean;
  };
  probes: RecognitionProbe[];
  classifier: string;
  provider: string;
  model: string;
  prompt_version: string;
  reasoning: string;
  failure_reason?: string;
};

type CandidateRow = {
  match_kind?: unknown;
  match_id?: unknown;
  observation_id?: unknown;
  display_name?: unknown;
  score?: unknown;
  basis?: unknown;
  last_seen_at?: unknown;
  plate_number?: unknown;
  person_record_id?: unknown;
  canonical_vehicle_id?: unknown;
  thumbnail?: unknown;
};

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const safeThumbnail = (value: unknown): string | null => {
  const thumbnail = asString(value);
  return thumbnail?.startsWith('data:image/') ? thumbnail : null;
};

const withoutEmbedding = (value: unknown): JsonRecord => {
  const record = asRecord(value);
  const allowed = [
    'upper_body_colour',
    'lower_body_colour',
    'vehicle_colour',
    'vehicle_type',
    'vehicle_make',
    'vehicle_model',
    'vehicle_year',
    'attribute_status',
    'appearance_embedding_model',
  ];
  return Object.fromEntries(allowed.flatMap((key) => key in record ? [[key, record[key]]] : []));
};

async function portfolioMatches(
  serviceSupabase: SupabaseClient,
  organizationId: string,
  entityKind: 'person' | 'vehicle',
  faceEmbedding: unknown,
  appearanceEmbedding: unknown,
  plate: string | null,
): Promise<RecognitionCandidate[]> {
  const { data, error } = await serviceSupabase.rpc('find_cctv_portfolio_matches', {
    p_organization_id: organizationId,
    p_entity_kind: entityKind,
    p_face_embedding: Array.isArray(faceEmbedding) ? faceEmbedding : null,
    p_appearance_embedding: Array.isArray(appearanceEmbedding) ? appearanceEmbedding : null,
    p_plate: plate,
    p_exclude_observation_id: null,
    p_limit: 5,
  });
  if (error) throw new Error(`Recognition candidate lookup failed: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as CandidateRow[];
  const personIds = [...new Set(rows.map((row) => asString(row.person_record_id)).filter((id): id is string => Boolean(id)))];
  const personReferences = new Map<string, { displayName: string | null; thumbnail: string | null }>();

  if (personIds.length) {
    const { data: people, error: peopleError } = await serviceSupabase
      .from('person_records')
      .select('id,display_name,metadata')
      .eq('organization_id', organizationId)
      .in('id', personIds);
    if (peopleError) throw new Error(`Recognition reference lookup failed: ${peopleError.message}`);
    for (const person of people ?? []) {
      const metadata = asRecord(person.metadata);
      const faceReference = asRecord(metadata.face_reference);
      personReferences.set(person.id, {
        displayName: asString(person.display_name),
        thumbnail: safeThumbnail(faceReference.thumbnail),
      });
    }
  }

  const deduplicated = new Map<string, RecognitionCandidate>();
  for (const row of rows) {
    const personRecordId = asString(row.person_record_id);
    const canonicalVehicleId = asString(row.canonical_vehicle_id);
    const matchId = asString(row.match_id) ?? asString(row.observation_id);
    const candidateId = personRecordId ?? canonicalVehicleId ?? matchId;
    const score = asNumber(row.score);
    if (!candidateId || score === null || score < 0 || score > 1) continue;
    const personReference = personRecordId ? personReferences.get(personRecordId) : null;
    const entityKey = `${entityKind}:${candidateId}`;
    const candidate: RecognitionCandidate = {
      candidate_id: candidateId,
      entity_kind: entityKind,
      match_kind: asString(row.match_kind) ?? 'observation',
      display_name: personReference?.displayName
        ?? asString(row.display_name)
        ?? (entityKind === 'vehicle' ? asString(row.plate_number) : null)
        ?? 'Unidentified prior observation',
      score,
      basis: asString(row.basis) ?? 'visual_similarity',
      person_record_id: personRecordId,
      canonical_vehicle_id: canonicalVehicleId,
      plate_number: asString(row.plate_number),
      reference_thumbnail: personReference?.thumbnail ?? safeThumbnail(row.thumbnail),
      last_seen_at: asString(row.last_seen_at),
    };
    const existing = deduplicated.get(entityKey);
    if (!existing || candidate.score > existing.score) deduplicated.set(entityKey, candidate);
  }

  return [...deduplicated.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function recognitionFrame(payload: JsonRecord, key: string): { values: unknown[]; variant: 'source' | 'enhanced' } {
  const recognition = asRecord(payload.recognition);
  const source = asRecord(recognition.source);
  const enhanced = asRecord(recognition.enhanced);
  const sourceValues = asArray(source[key]);
  return sourceValues.length
    ? { values: sourceValues, variant: 'source' }
    : { values: asArray(enhanced[key]), variant: 'enhanced' };
}

function alprFrame(payload: JsonRecord): { value: JsonRecord; variant: 'source' | 'enhanced' } {
  const recognition = asRecord(payload.recognition);
  const source = asRecord(asRecord(recognition.source).alpr);
  if (asString(source.plate) || asArray(source.results).length) return { value: source, variant: 'source' };
  return { value: asRecord(asRecord(recognition.enhanced).alpr), variant: 'enhanced' };
}

export async function inferAccessRecognition(options: {
  bytes: Uint8Array;
  sourceSha256: string;
  organizationId: string;
  inferenceServiceUrl: string;
  inferenceApiKey: string;
  serviceSupabase: SupabaseClient;
}): Promise<AccessRecognitionReceipt> {
  if (!options.inferenceServiceUrl || !options.inferenceApiKey) {
    throw new Error('Deterministic recognition service is not configured');
  }

  const requestBody = new FormData();
  requestBody.append(
    'photo',
    new Blob([Uint8Array.from(options.bytes).buffer], { type: 'image/jpeg' }),
    'recognition-probe.jpg',
  );
  requestBody.append('tasks', JSON.stringify(['person', 'vehicle', 'plate', 'face']));
  requestBody.append('source_frame_hash', options.sourceSha256);

  const response = await fetch(`${options.inferenceServiceUrl}/infer/enhance`, {
    method: 'POST',
    headers: { 'x-inference-api-key': options.inferenceApiKey },
    body: requestBody,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Deterministic recognition failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const payload = asRecord(await response.json());
  if (payload.success !== true) throw new Error(asString(payload.error) ?? 'Deterministic recognition returned no result');

  const probes: RecognitionProbe[] = [];
  const faces = recognitionFrame(payload, 'faces');
  for (const [index, rawFace] of faces.values.slice(0, 3).entries()) {
    const face = asRecord(rawFace);
    probes.push({
      probe_id: `face-${index + 1}`,
      probe_kind: 'face',
      source_variant: faces.variant,
      detector_confidence: asNumber(face.detector_confidence),
      bbox: Object.keys(asRecord(face.bbox)).length ? asRecord(face.bbox) : null,
      plate_number: null,
      plate_confidence: null,
      attributes: {
        face_crop_width_px: asNumber(face.face_crop_width_px),
        alignment_basis: asString(face.alignment_basis),
        detector_model: asString(face.face_detector_model),
        embedding_model: asString(face.face_embedding_model),
      },
      candidates: await portfolioMatches(
        options.serviceSupabase,
        options.organizationId,
        'person',
        face.embedding,
        null,
        null,
      ),
    });
  }

  const people = recognitionFrame(payload, 'people');
  for (const [index, rawPerson] of people.values.slice(0, 3).entries()) {
    const person = asRecord(rawPerson);
    const attributes = asRecord(person.attributes);
    probes.push({
      probe_id: `person-${index + 1}`,
      probe_kind: 'person',
      source_variant: people.variant,
      detector_confidence: asNumber(person.confidence),
      bbox: Object.keys(asRecord(person.bbox)).length ? asRecord(person.bbox) : null,
      plate_number: null,
      plate_confidence: null,
      attributes: withoutEmbedding(attributes),
      candidates: await portfolioMatches(
        options.serviceSupabase,
        options.organizationId,
        'person',
        null,
        attributes.appearance_embedding,
        null,
      ),
    });
  }

  const alpr = alprFrame(payload);
  const alprResults = asArray(alpr.value.results).map(asRecord);
  const bestPlate = asString(alpr.value.plate) ?? asString(alprResults[0]?.plate);
  const bestPlateConfidence = asNumber(alpr.value.confidence) ?? asNumber(alprResults[0]?.score);
  const vehicles = recognitionFrame(payload, 'vehicles');
  const vehicleValues = vehicles.values.length ? vehicles.values.slice(0, 3) : (bestPlate ? [{}] : []);
  for (const [index, rawVehicle] of vehicleValues.entries()) {
    const vehicle = asRecord(rawVehicle);
    const attributes = asRecord(vehicle.attributes);
    probes.push({
      probe_id: `vehicle-${index + 1}`,
      probe_kind: vehicles.values.length ? 'vehicle' : 'plate',
      source_variant: vehicles.values.length ? vehicles.variant : alpr.variant,
      detector_confidence: asNumber(vehicle.confidence),
      bbox: Object.keys(asRecord(vehicle.bbox)).length ? asRecord(vehicle.bbox) : null,
      plate_number: index === 0 ? bestPlate : null,
      plate_confidence: index === 0 ? bestPlateConfidence : null,
      attributes: withoutEmbedding(attributes),
      candidates: await portfolioMatches(
        options.serviceSupabase,
        options.organizationId,
        'vehicle',
        null,
        attributes.appearance_embedding,
        index === 0 ? bestPlate : null,
      ),
    });
  }

  const personPresent = people.values.length > 0 || faces.values.length > 0;
  const vehiclePresent = vehicles.values.length > 0 || Boolean(bestPlate);
  const subjectKind = personPresent && vehiclePresent
    ? 'mixed'
    : personPresent
      ? 'person'
      : vehiclePresent
        ? 'vehicle'
        : 'unknown';
  const confidenceValues = probes.flatMap((probe) => [
    probe.detector_confidence,
    probe.plate_confidence,
    probe.candidates[0]?.score ?? null,
  ]).filter((value): value is number => typeof value === 'number');
  const candidateCount = probes.reduce((count, probe) => count + probe.candidates.length, 0);

  return {
    status: 'available',
    classification: `${probes.length} recognition probe${probes.length === 1 ? '' : 's'}; ${candidateCount} possible match${candidateCount === 1 ? '' : 'es'}`,
    confidence: confidenceValues.length ? Math.max(...confidenceValues) : 0,
    details: {
      subject_kind: subjectKind,
      person_present: personPresent,
      face_visible: faces.values.length > 0,
      credential_visible: null,
      vehicle_present: vehiclePresent,
    },
    probes,
    classifier: 'deterministic_multimodal_candidate_matcher',
    provider: 'fcm-inference',
    model: 'yunet-sface-openvino-alpr-reid',
    prompt_version: 'access_recognition_v2',
    reasoning: candidateCount
      ? 'Possible matches are ranked from face, body, vehicle appearance, and plate similarity. A user must confirm any durable identity or access decision.'
      : 'Recognition completed, but no stored person or vehicle exceeded the configured similarity thresholds.',
  };
}
