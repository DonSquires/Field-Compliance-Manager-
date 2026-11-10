/**
 * process-officer-scan — Core scan pipeline Edge Function
 *
 * Source of truth: docs/INSTRUCTION_MANUAL.md §4.2 Patrol & Scanning
 *                  docs/CLEAN_REBUILD_DESIGN.md §5 Edge Function Set
 *                  docs/INFERENCE_CONTRACT_V1.md
 *
 * This is the most critical Edge Function in the system.
 * Every officer scan goes through here.
 *
 * Pipeline (12 steps):
 *   1.  Auth — validate JWT, resolve officer profile
 *   2.  Parse input — plate, GPS, photo, module context
 *   3.  ALPR — POST /infer/alpr to inference service (self-hosted OCR)
 *       └─ Falls back to manual plate entry if unavailable
 *   4.  Full inference — POST /infer to inference service
 *       Returns: embedding[384], make/model/colour, sticker, detection bbox
 *       Runs in parallel with ALPR (same photo, two calls)
 *   5.  Zone detection — get_zone_for_gps() PostGIS RPC
 *   6.  Canonical lookups — canonical_vehicles, canonical_scv, canonical_homeless
 *       + fetch previous observation embedding + observed_at for movement detection
 *       + fetch org verification_mode from freedom_camping_org_settings (0191)
 *   7.  Movement detection — POST /infer/compare with previous embedding
 *       similarity < 0.85 = vehicle moved
 *  7a.  Overnight window classification (read-only peek, BRANCHED on verification_mode):
 *       - two_photo_verified:       classifyOvernightWindow (local-midnight split)
 *       - single_daily_observation: peekSingleDailyObservation (calendar-day adjacency)
 *  7b.  Pre-compliance session write (BRANCHED on verification_mode):
 *       - two_photo_verified:       upsertOvernightSession
 *       - single_daily_observation: upsertSingleDailyOvernightSession
 *   8.  Compliance check — calculate_vehicle_compliance() RPC
 *       + SCV sticker override (blue sticker = SCV-compliant)
 *       + Homeless override (never enforce against welfare vehicles)
 *   9.  Write observation — full record with embedding, sticker, movement
 *  10.  Create breach alert — if non-compliant AND verified_overnight
 *       (two_photo: morning + verified; single_daily: consecutive-day + verified)
 * 10b.  Post-compliance session update (real observation_id, photo, breach_alert_id)
 *  11.  Log GPS — non-blocking
 *  12.  Return verdict
 *
 * Env secrets required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   INFERENCE_SERVICE_URL   — FCM inference service base URL
 *   INFERENCE_API_KEY       — shared secret with inference service
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFERENCE_SERVICE_URL = (Deno.env.get('INFERENCE_SERVICE_URL') ?? '').replace(/\/+$/, '');
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const PLATE_RECOGNIZER_API_URL = Deno.env.get('PLATE_RECOGNIZER_API_URL') ?? 'https://api.platerecognizer.com/v1/plate-reader/';
const PLATE_RECOGNIZER_API_TOKEN = Deno.env.get('PLATE_RECOGNIZER_API_TOKEN') ?? '';
const ALPR_TIMEOUT_MS = 20_000;
const PLATE_RECOGNIZER_TIMEOUT_MS = 20_000;
const INFER_TIMEOUT_MS = 30_000;
const MIN_ALPR_CONFIDENCE = 0.75;
const SCAN_BUCKET = 'scans';
// H&S exception (ORG_SERVICE_MODEL): every organisation's active hazard warnings on the plate, redacted by
// get_safety_warnings (hazard class, severity, raising organisation + contact path; never the narrative).
// Service-role callers are admitted by the RPC; the officer's own organisation is marked so the UI can say so.
async function loadSafetyWarnings(supabase, vehicleId, orgId) {
  if (!vehicleId) return [];
  const { data, error } = await supabase.rpc('get_safety_warnings', {
    p_entity_type: 'vehicle',
    p_entity_ids: [
      vehicleId
    ]
  });
  if (error || !Array.isArray(data)) return [];
  return data.map((warning)=>({
      id: warning.id,
      hazard_class: warning.hazard_class,
      alert_level: warning.alert_level,
      raised_at: warning.raised_at,
      organization_name: warning.organization_name,
      contact_email: warning.contact_email,
      contact_phone: warning.contact_phone,
      is_own_organization: warning.organization_id === orgId
    }));
}
// GEOFENCE_PRINCIPLES P1: one distinct, loud message per resolver outcome. 'resolved' carries none.
const GEOFENCE_NOTICE = {
  resolved: null,
  outside_all_geofences: 'Outside all verified geofences for this organisation. Evidence recorded; no zone rules were applied.',
  unresolved_no_geofence: 'No geofence is configured where this scan was taken. Evidence recorded; no zone rules were applied. An administrator must configure and verify the boundary in Location House before enforcement can rely on it.',
  unresolved_unverified: 'A boundary exists here but has not been visually verified on the map. Evidence recorded; no zone rules were applied until it is verified in Location House.',
  unresolved_invalid: 'The boundary here has invalid geometry. Evidence recorded; no zone rules were applied until it is redrawn or re-imported in Location House.',
  not_evaluated: 'No GPS fix was supplied, so no geofence could be evaluated. Evidence recorded without place resolution.'
};
function normalizePlateNumber(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}
// ── Inference service helpers ─────────────────────────────────────────────────
function inferenceHeaders() {
  return {
    'x-inference-api-key': INFERENCE_API_KEY,
    'Authorization': `Bearer ${INFERENCE_API_KEY}`
  };
}
/** Step 3: ALPR — POST /infer/alpr (multipart photo upload) */ async function runAlpr(imageBase64) {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) return null;
  try {
    const binaryStr = atob(imageBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for(let i = 0; i < binaryStr.length; i++)bytes[i] = binaryStr.charCodeAt(i);
    const formData = new FormData();
    formData.append('photo', new Blob([
      bytes
    ], {
      type: 'image/jpeg'
    }), 'scan.jpg');
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), ALPR_TIMEOUT_MS);
    const res = await fetch(`${INFERENCE_SERVICE_URL}/infer/alpr`, {
      method: 'POST',
      headers: inferenceHeaders(),
      body: formData,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[scan] ALPR HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.success) return null;
    const results = data.results;
    const best = results?.[0];
    return {
      plate: best?.plate ?? data.plate ?? null,
      confidence: best?.score ?? data.confidence ?? 0,
      bbox: best?.box ?? null,
      provider: 'local'
    };
  } catch (err) {
    console.warn(`[scan] ALPR error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
/** Optional Plate Recognizer Snapshot fallback. Disabled unless API token is configured. */ async function runPlateRecognizerAlpr(imageBase64) {
  if (!PLATE_RECOGNIZER_API_TOKEN) return null;
  try {
    const binaryStr = atob(imageBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for(let i = 0; i < binaryStr.length; i++)bytes[i] = binaryStr.charCodeAt(i);
    const formData = new FormData();
    formData.append('upload', new Blob([
      bytes
    ], {
      type: 'image/jpeg'
    }), 'scan.jpg');
    formData.append('regions', 'nz');
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), PLATE_RECOGNIZER_TIMEOUT_MS);
    const res = await fetch(PLATE_RECOGNIZER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${PLATE_RECOGNIZER_API_TOKEN}`
      },
      body: formData,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[scan] Plate Recognizer HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const results = data.results ?? [];
    const best = results[0];
    const rawPlate = best?.plate;
    const confidence = Number(best?.score ?? 0);
    const box = best?.box;
    const plate = rawPlate ? normalizePlateNumber(rawPlate) : null;
    if (!plate) return null;
    return {
      plate,
      confidence: confidence > 1 ? confidence / 100 : confidence,
      bbox: box ?? null,
      provider: 'plate_recognizer'
    };
  } catch (err) {
    console.warn(`[scan] Plate Recognizer error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
/** Step 4: Full inference — POST /infer (embedding + attributes + sticker) */ async function runInference(imageBase64) {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) return null;
  try {
    const binaryStr = atob(imageBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for(let i = 0; i < binaryStr.length; i++)bytes[i] = binaryStr.charCodeAt(i);
    const formData = new FormData();
    formData.append('photo', new Blob([
      bytes
    ], {
      type: 'image/jpeg'
    }), 'scan.jpg');
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), INFER_TIMEOUT_MS);
    const res = await fetch(`${INFERENCE_SERVICE_URL}/infer`, {
      method: 'POST',
      headers: inferenceHeaders(),
      body: formData,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[scan] /infer HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.success) return null;
    const d = data.data;
    const sticker = d?.sticker;
    const detection = d?.detection;
    return {
      embedding: d?.embedding ?? null,
      embedding_quality: d?.embedding_quality ?? null,
      detection_bbox: detection?.bbox ?? null,
      detection_confidence: detection?.confidence ?? null,
      vehicle_make: d?.vehicle_make ?? null,
      vehicle_model: d?.vehicle_model ?? null,
      vehicle_year: d?.vehicle_year ?? null,
      vehicle_colour: d?.vehicle_colour ?? d?.vehicle_color ?? null,
      sticker_presence: sticker?.presence ?? null,
      sticker_color: sticker?.color ?? null,
      sticker_confidence: sticker?.detection_confidence ?? null
    };
  } catch (err) {
    console.warn(`[scan] /infer error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
/** Step 7: Movement detection — compare vehicle embedding and prior scene evidence. */ async function runMovementCheck(newEmbedding, prevEmbedding, currentImageBase64 = null, previousPhotoPath = null, supabase = null) {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) return null;
  if (!newEmbedding?.length || !prevEmbedding?.length) return null;
  try {
    let previousImageBase64 = null;
    if (supabase && previousPhotoPath) {
      const { data: signed } = await supabase.storage.from(SCAN_BUCKET).createSignedUrl(previousPhotoPath, 60);
      if (signed?.signedUrl) {
        const previousImage = await fetch(signed.signedUrl);
        if (previousImage.ok) {
          const bytes = new Uint8Array(await previousImage.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          previousImageBase64 = btoa(binary);
        }
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 10_000);
    const res = await fetch(`${INFERENCE_SERVICE_URL}/infer/compare`, {
      method: 'POST',
      headers: {
        ...inferenceHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embedding1: prevEmbedding,
        embedding2: newEmbedding,
        image1: previousImageBase64,
        image2: currentImageBase64
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const decision = data.confidence === 'different' && data.scene_confidence === 'changed' ? 'moved'
      : data.confidence === 'same' && data.scene_confidence === 'same' ? 'stationary' : 'inconclusive';
    return {
      moved: decision === 'moved',
      similarity: data.similarity ?? 0,
      decision,
      scene_similarity: data.scene_similarity ?? null,
      scene_confidence: data.scene_confidence ?? 'unavailable'
    };
  } catch (err) {
    console.warn(`[scan] /infer/compare error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
// Phase 1 (pre-compliance): classify the scan window and peek at the existing
// session row WITHOUT writing anything. This runs before calculate_vehicle_compliance
// so the RPC sees an accurate picture of verified sessions (0193).
async function classifyOvernightWindow(supabase, orgId, plateNumber, zoneId, observedAt) {
  if (!zoneId) return {
    scanWindow: null,
    overnightDate: null,
    existingSessionId: null,
    priorVerificationStatus: null
  };
  const { data: windowRows, error: windowErr } = await supabase.rpc('classify_fc_overnight_window', {
    p_observed_at: observedAt,
    p_timezone: 'Pacific/Auckland'
  });
  if (windowErr || !Array.isArray(windowRows) || !windowRows.length) {
    console.warn('[scan] overnight window classification failed:', windowErr?.message);
    return {
      scanWindow: null,
      overnightDate: null,
      existingSessionId: null,
      priorVerificationStatus: null
    };
  }
  const overnightDate = String(windowRows[0].overnight_date);
  const scanWindow = windowRows[0].scan_window;
  const { data: existing } = await supabase.from('vehicle_overnight_sessions').select('id, verification_status').eq('organization_id', orgId).eq('plate_number', plateNumber).eq('zone_id', zoneId).eq('overnight_date', overnightDate).maybeSingle();
  return {
    scanWindow,
    overnightDate,
    existingSessionId: existing?.id ?? null,
    priorVerificationStatus: existing?.verification_status ?? null
  };
}
// Phase 2 (post-compliance): write the session row now that we have the
// compliance verdict. For a morning scan this stamps is_compliant + breach_alert_id
// on the session row that was already written in Phase 1.
async function upsertOvernightSession(supabase, input) {
  if (!input.zoneId || !input.windowPeek.scanWindow || !input.windowPeek.overnightDate) {
    return {
      id: null,
      overnight_date: null,
      scan_window: null,
      verification_status: null,
      requires_morning_verification: false,
      duplicate_for_window: false,
      observation_count: null
    };
  }
  const { scanWindow, overnightDate, existingSessionId } = input.windowPeek;
  if (scanWindow === 'evening') {
    if (existingSessionId) {
      const { data: existing } = await supabase.from('vehicle_overnight_sessions').select('observation_count, verification_status').eq('id', existingSessionId).maybeSingle();
      const count = Number(existing?.observation_count ?? 1) + 1;
      const { error: sessionWriteError } = await supabase.from('vehicle_overnight_sessions').update({
        evening_observation_id: input.observationId,
        evening_seen_at: input.observedAt,
        evening_gps_lat: input.gpsLat,
        evening_gps_lng: input.gpsLng,
        evening_photo_url: input.photoUrl,
        observation_count: count,
        updated_at: new Date().toISOString()
      }).eq('id', existingSessionId);
      if (sessionWriteError) throw new Error('The evening overnight evidence could not be saved.');
      return {
        id: existingSessionId,
        overnight_date: overnightDate,
        scan_window: scanWindow,
        verification_status: existing?.verification_status ?? 'candidate_evening',
        requires_morning_verification: true,
        duplicate_for_window: true,
        observation_count: count
      };
    }
    // New evening session -- is_compliant intentionally null (awaiting morning).
    const { data: created, error: sessionWriteError } = await supabase.from('vehicle_overnight_sessions').insert({
      organization_id: input.orgId,
      plate_number: input.plateNumber,
      zone_id: input.zoneId,
      site_id: input.siteId,
      location_id: input.locationId,
      overnight_date: overnightDate,
      evening_observation_id: input.observationId,
      evening_seen_at: input.observedAt,
      evening_gps_lat: input.gpsLat,
      evening_gps_lng: input.gpsLng,
      evening_photo_url: input.photoUrl,
      verification_status: 'candidate_evening',
      evidence_strength: 'pending',
      observation_count: 1,
      is_scv: input.isScv,
      is_compliant: null,
      compliance_reason: 'awaiting_morning_verification',
      client_org_id: input.clientOrgId ?? null
    }).select('id').single();
    if (sessionWriteError || !created?.id) throw new Error('The evening overnight session was not confirmed.');
    return {
      id: created?.id ?? null,
      overnight_date: overnightDate,
      scan_window: scanWindow,
      verification_status: 'candidate_evening',
      requires_morning_verification: true,
      duplicate_for_window: false,
      observation_count: 1
    };
  }
  // Morning scan path.
  if (!existingSessionId) {
    return {
      id: null,
      overnight_date: overnightDate,
      scan_window: scanWindow,
      verification_status: 'manual_review_required',
      requires_morning_verification: false,
      duplicate_for_window: false,
      observation_count: null
    };
  }
  const { data: existing } = await supabase.from('vehicle_overnight_sessions').select('observation_count').eq('id', existingSessionId).maybeSingle();
  const moved = input.movementResult?.decision === 'moved';
  const inconclusive = !input.movementResult || input.movementResult.decision === 'inconclusive';
  const verificationStatus = moved ? 'moved' : inconclusive ? 'inconclusive' : 'verified_overnight';
  const evidenceStrength = verificationStatus === 'verified_overnight' ? 'strong' : 'manual_review';
  const count = Number(existing?.observation_count ?? 1) + 1;
  const { error: sessionWriteError } = await supabase.from('vehicle_overnight_sessions').update({
    morning_observation_id: input.observationId,
    morning_seen_at: input.observedAt,
    morning_gps_lat: input.gpsLat,
    morning_gps_lng: input.gpsLng,
    morning_photo_url: input.photoUrl,
    verification_status: verificationStatus,
    movement_decision: input.movementResult?.decision ?? 'inconclusive',
    movement_similarity: input.movementResult?.similarity ?? null,
    evidence_strength: evidenceStrength,
    manual_review_required: verificationStatus !== 'verified_overnight',
    observation_count: count,
    is_scv: input.isScv,
    is_compliant: verificationStatus === 'verified_overnight' ? input.complianceIsCompliant : null,
    compliance_reason: verificationStatus === 'verified_overnight' ? input.complianceReason : verificationStatus,
    breach_alert_id: verificationStatus === 'verified_overnight' ? input.breachAlertId : null,
    updated_at: new Date().toISOString()
  }).eq('id', existingSessionId);
  if (sessionWriteError) throw new Error('The morning overnight evidence could not be saved.');
  return {
    id: existingSessionId,
    overnight_date: overnightDate,
    scan_window: scanWindow,
    verification_status: verificationStatus,
    requires_morning_verification: false,
    duplicate_for_window: false,
    observation_count: count
  };
}
// ── single_daily_observation helpers ───────────────────────────────────────
//
// For orgs configured with verification_mode='single_daily_observation' (0191),
// overnight presence is INFERRED by comparing today's scan to the previous
// day's scan of the same plate+zone, using calendar-day adjacency — NOT the
// time-of-day evening/morning split used by two_photo_verified.
//
// Design (from 0195 header + #73/#74 + old-app product-memory):
//   - Previous observation was exactly yesterday (same plate+zone+org)?
//     → The pair straddles one inferred overnight for overnight_date = prevObsDate.
//   - Movement check result determines verification_status:
//       stationary   → verified_overnight (evidence_strength = moderate)
//       moved        → not_verified       (evidence_strength = weak)
//       inconclusive → manual_review_required (evidence_strength = manual_review)
//   - Both halves of vehicle_overnight_sessions are filled: evening_* from the
//     PREVIOUS observation, morning_* from the CURRENT scan — reusing the
//     existing evening/morning columns intentionally (the table is generic).
//   - calculate_vehicle_compliance (0195) reads vehicle_overnight_sessions
//     generically regardless of how the row was produced — no changes needed.
//
// Ancestor: old app FreedomCamp-Manager overnight_verification_mode =
// 'one_photo_per_day_inference' ("single photo per day; AI infers overnight
// presence"). This is the correct re-expression for the new schema/session model.
/** Convert a timestamptz string to a YYYY-MM-DD local date in Pacific/Auckland. */ function toLocalDate(timestamptz) {
  const d = new Date(timestamptz);
  // Intl.DateTimeFormat with 'en-CA' locale produces YYYY-MM-DD natively.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}
/** Add (or subtract) calendar days from a YYYY-MM-DD date string. */ function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
/**
 * peekSingleDailyObservation — read-only classification for single_daily_observation orgs.
 * Mirrors classifyOvernightWindow's role: determines whether this scan + the previous
 * observation form a consecutive-day pair, and what the inferred verification status
 * would be. Does NOT write anything.
 */ function peekSingleDailyObservation(supabase, orgId, plateNumber, zoneId, observedAt, prevObs, movementResult) {
  // Suppress the unused-parameter lint — supabase is accepted for signature
  // symmetry with classifyOvernightWindow (the two_photo_verified peek) and
  // will be used if we ever need to query existing sessions here.
  void supabase;
  void orgId;
  void plateNumber;
  if (!zoneId || !prevObs?.observed_at) {
    return {
      overnightDate: null,
      existingSessionId: null,
      priorVerificationStatus: null,
      inferredVerificationStatus: null,
      inferredEvidenceStrength: null,
      manualReviewRequired: false
    };
  }
  const todayLocalDate = toLocalDate(observedAt);
  const prevObsDate = toLocalDate(prevObs.observed_at);
  // Adjacent-day check: previous observation was exactly yesterday?
  if (prevObsDate !== addDays(todayLocalDate, -1)) {
    // No consecutive-day pair — this scan cannot resolve an overnight for
    // the previous night. It will be resolved (if at all) by the NEXT day's
    // scan looking backward at today.
    return {
      overnightDate: null,
      existingSessionId: null,
      priorVerificationStatus: null,
      inferredVerificationStatus: null,
      inferredEvidenceStrength: null,
      manualReviewRequired: false
    };
  }
  // We have a consecutive-day pair: overnight_date = prevObsDate (the night
  // between yesterday's observation and today's observation).
  const overnightDate = prevObsDate;
  // Derive verification status from the SAME movementResult already computed
  // in Step 7 — no new inference call needed.
  let inferredVerificationStatus;
  let inferredEvidenceStrength;
  let manualReviewRequired = false;
  if (movementResult?.decision === 'stationary') {
    inferredVerificationStatus = 'verified_overnight';
    inferredEvidenceStrength = 'moderate'; // single-daily inference: lower than two-photo 'strong', higher than historical 'inferred'
  } else if (movementResult?.decision === 'moved') {
    inferredVerificationStatus = 'not_verified';
    inferredEvidenceStrength = 'weak'; // vehicle left; yesterday was a day visit
  } else {
    // No movement result or inconclusive
    inferredVerificationStatus = 'manual_review_required';
    inferredEvidenceStrength = 'manual_review';
    manualReviewRequired = true;
  }
  return {
    overnightDate,
    existingSessionId: null,
    priorVerificationStatus: null,
    inferredVerificationStatus,
    inferredEvidenceStrength,
    manualReviewRequired
  };
}
/**
 * upsertSingleDailyOvernightSession — write path for single_daily_observation orgs.
 * Mirrors upsertOvernightSession's role: creates or updates a vehicle_overnight_sessions
 * row for the inferred overnight between yesterday's and today's observations.
 *
 * IMPORTANT: unlike the two_photo_verified path's fragile pattern where a stale
 * existingSessionId from the peek is reused across pre- and post-compliance calls,
 * this function returns the REAL session id from the write so the caller can thread
 * it explicitly into the post-compliance update call.
 */ async function upsertSingleDailyOvernightSession(supabase, input) {
  if (!input.zoneId || !input.singleDailyPeek.overnightDate) {
    return {
      id: null,
      overnight_date: null,
      scan_window: null,
      verification_status: null,
      requires_morning_verification: false,
      duplicate_for_window: false,
      observation_count: null
    };
  }
  const { overnightDate, inferredVerificationStatus, inferredEvidenceStrength, manualReviewRequired } = input.singleDailyPeek;
  // Check for an existing session row (unique constraint: org+plate+zone+date).
  const { data: existing } = await supabase.from('vehicle_overnight_sessions').select('id, verification_status, observation_count').eq('organization_id', input.orgId).eq('plate_number', input.plateNumber).eq('zone_id', input.zoneId).eq('overnight_date', overnightDate).maybeSingle();
  if (existing?.id) {
    // Session already exists for this overnight_date — update it with the
    // current scan's data (morning side) and the real compliance verdict.
    const count = Number(existing.observation_count ?? 1) + 1;
    const { error: sessionWriteError } = await supabase.from('vehicle_overnight_sessions').update({
      morning_observation_id: input.observationId,
      morning_seen_at: input.observedAt,
      morning_gps_lat: input.gpsLat,
      morning_gps_lng: input.gpsLng,
      morning_photo_url: input.photoUrl,
      verification_status: inferredVerificationStatus,
      movement_decision: input.movementResult?.decision ?? 'inconclusive',
      movement_similarity: input.movementResult?.similarity ?? null,
      evidence_strength: inferredEvidenceStrength,
      manual_review_required: manualReviewRequired,
      observation_count: count,
      is_scv: input.isScv,
      is_compliant: inferredVerificationStatus === 'verified_overnight' ? input.complianceIsCompliant : null,
      compliance_reason: inferredVerificationStatus === 'verified_overnight' ? input.complianceReason : inferredVerificationStatus,
      breach_alert_id: inferredVerificationStatus === 'verified_overnight' ? input.breachAlertId : null,
      updated_at: new Date().toISOString()
    }).eq('id', existing.id);
    if (sessionWriteError) throw new Error('The daily overnight evidence could not be saved.');
    return {
      id: existing.id,
      overnight_date: overnightDate,
      scan_window: 'morning',
      verification_status: inferredVerificationStatus,
      requires_morning_verification: false,
      duplicate_for_window: true,
      observation_count: count
    };
  }
  // No existing session — insert a new row. Fill BOTH halves:
  // evening_* from the PREVIOUS observation, morning_* from the CURRENT scan.
  const { data: created, error: sessionWriteError } = await supabase.from('vehicle_overnight_sessions').insert({
    organization_id: input.orgId,
    plate_number: input.plateNumber,
    zone_id: input.zoneId,
    site_id: input.siteId,
    location_id: input.locationId,
    overnight_date: overnightDate,
    // Evening side: previous observation
    evening_observation_id: input.prevObs?.id ?? null,
    evening_seen_at: input.prevObs?.observed_at ?? null,
    evening_gps_lat: null,
    evening_gps_lng: null,
    evening_photo_url: input.prevObs?.photo_url ?? null,
    // Morning side: current scan
    morning_observation_id: input.observationId,
    morning_seen_at: input.observedAt,
    morning_gps_lat: input.gpsLat,
    morning_gps_lng: input.gpsLng,
    morning_photo_url: input.photoUrl,
    verification_status: inferredVerificationStatus,
    movement_decision: input.movementResult?.decision ?? 'inconclusive',
    movement_similarity: input.movementResult?.similarity ?? null,
    evidence_strength: inferredEvidenceStrength,
    manual_review_required: manualReviewRequired,
    observation_count: 2,
    is_scv: input.isScv,
    is_compliant: inferredVerificationStatus === 'verified_overnight' ? input.complianceIsCompliant : null,
    compliance_reason: inferredVerificationStatus === 'verified_overnight' ? input.complianceReason : inferredVerificationStatus ?? 'pending',
    breach_alert_id: inferredVerificationStatus === 'verified_overnight' ? input.breachAlertId : null,
    client_org_id: input.clientOrgId ?? null
  }).select('id').single();
  if (sessionWriteError || !created?.id) throw new Error('The daily overnight session was not confirmed.');
  return {
    id: created?.id ?? null,
    overnight_date: overnightDate,
    scan_window: 'morning',
    verification_status: inferredVerificationStatus,
    requires_morning_verification: false,
    duplicate_for_window: false,
    observation_count: 2
  };
}
function base64ToBytes(imageBase64) {
  const binaryStr = atob(imageBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for(let i = 0; i < binaryStr.length; i++)bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}
async function sha256Hex(value) {
  const payload = value instanceof Blob ? await value.arrayBuffer() : value;
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest), (byte)=>byte.toString(16).padStart(2, '0')).join('');
}
async function renderWatermarkedEvidence(bytes, watermarkText) {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) {
    throw new Error('Inference watermark service is not configured; photo evidence cannot be accepted');
  }
  const formData = new FormData();
  formData.append('photo', new Blob([
    bytes
  ], {
    type: 'image/jpeg'
  }), 'scan.jpg');
  formData.append('watermark_text', watermarkText);
  const res = await fetch(`${INFERENCE_SERVICE_URL}/infer/watermark`, {
    method: 'POST',
    headers: {
      'x-inference-api-key': INFERENCE_API_KEY
    },
    body: formData,
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new Error(`Inference watermark service failed with HTTP ${res.status}`);
  }
  return await res.blob();
}
async function attachScanEvidence(supabase, evidence, input) {
  if (!evidence?.evidence_id) throw new Error('The registered scan photo could not be linked to its record.');
  const recordKey = input.recordType === 'observation' ? 'observation_id' : 'parking_chalk_record_id';
  const { data: item, error: itemError } = await supabase.from('evidence_items').select('id, organization_id, module_key, metadata')
    .eq('id', evidence.evidence_id).eq('organization_id', input.orgId).maybeSingle();
  if (itemError || !item || item.module_key !== input.moduleKey) throw new Error('The registered scan photo could not be verified for this record.');
  const existingRecordId = item.metadata?.[recordKey];
  if (existingRecordId && existingRecordId !== input.recordId) throw new Error('The registered scan photo is already attached to another record.');
  const metadata = { ...item.metadata, [recordKey]: input.recordId, capture_state: 'linked' };
  const { data: updated, error: updateError } = await supabase.from('evidence_items').update({ metadata })
    .eq('id', evidence.evidence_id).eq('organization_id', input.orgId).select('id').maybeSingle();
  if (updateError || !updated) throw new Error('The registered scan photo could not be linked to its record.');
  const { error: auditError } = await supabase.from('audit_log').insert({
    organization_id: input.orgId,
    actor_user_id: input.officerId,
    action: 'edge_court_photo_attached',
    target_table: 'evidence_items',
    target_id: evidence.evidence_id,
    metadata: { record_type: input.recordType, record_id: input.recordId, request_id: input.clientRequestId || null }
  });
  if (auditError) throw new Error('The scan photo association audit could not be confirmed.');
  return {
    originalPath: evidence.original_path,
    watermarkedPath: evidence.storage_path,
    watermarkText: evidence.watermark_text,
    rawSha256: evidence.raw_sha256,
    watermarkedSha256: evidence.watermarked_sha256
  };
}
// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  let requestReceipt = null;
  let safeToRetry = true;
  let captureEvidence = null;
  let recoveryFromFingerprint = null;
  const json = async (body, status = 200)=>{
    if (status >= 400 && requestReceipt?.owned) {
      const { error } = await requestReceipt.client.from('officer_command_requests').update({
        command_status: 'failed',
        response: { ...body, success: false, http_status: status, retryable: safeToRetry, request_fingerprint: requestReceipt.fingerprint, capture_evidence: captureEvidence, recovery_from_fingerprint: recoveryFromFingerprint }
      }).eq('request_id', requestReceipt.id).eq('actor_user_id', requestReceipt.actorId);
      if (error) console.error('[scan] failure receipt could not be finalized');
    }
    return new Response(JSON.stringify({ ...body, ...(status >= 400 ? { retryable: safeToRetry, capture_saved: captureEvidence !== null } : {}) }), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  };
  try {
    // Step 1: Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const callerClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || SUPABASE_SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false }
    });
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const { data: profile } = await supabase.from('user_profiles').select('id, role, organization_id').eq('id', user.id).is('deactivated_at', null).single();
    if (!profile?.organization_id) return json({
      error: 'Officer profile not found or not linked to an organisation'
    }, 403);
    if (!['officer', 'admin_officer', 'admin', 'master', 'grand_master', 'scan_operator'].includes(profile.role)) {
      return json({ error: 'An active operational role is required to process vehicle evidence' }, 403);
    }
    const actorOrgId = profile.organization_id;
    const officerId = profile.id;
    // Step 2: Parse input
    const body = await req.json();
    const { plate_number: manualPlateNumberInput, image_base64: imageBase64, gps_lat: submittedGpsLat, gps_lng: submittedGpsLng, zone_id: expectedWorkingZoneId, module_key: moduleKey = 'freedom_camping', captured_at: capturedAt, offline_queued: offlineQueued = false, synced_at: syncedAt } = body;
    const explicitOperatingOrgId = typeof body.operating_organization_id === 'string' && body.operating_organization_id.trim()
      ? body.operating_organization_id.trim()
      : null;
    const requestedOrgId = explicitOperatingOrgId ?? actorOrgId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOrgId)) return json({ error: 'Operating organization ID is invalid' }, 400);
    let orgId = requestedOrgId;
    const locationSource = ['device_gps', 'address_candidate', 'manual_zone', 'unavailable'].includes(body.location_source)
      ? body.location_source
      : expectedWorkingZoneId ? 'manual_zone' : 'unavailable';
    const manualZoneId = locationSource === 'device_gps' ? null : expectedWorkingZoneId ?? null;
    const requestedLocationId = typeof body.location_id === 'string' ? body.location_id : null;
    const requestedSiteId = typeof body.client_site_id === 'string' ? body.client_site_id : null;
    const serviceAgreementId = typeof body.service_agreement_id === 'string' ? body.service_agreement_id : null;
    const { data: operatingContexts, error: operatingOrganizationError } = await callerClient.rpc('get_operating_organization_contexts');
    if (operatingOrganizationError) return json({ error: 'Operating organization access could not be verified' }, 503);
    const operatingContext = (operatingContexts ?? []).find((context) => context.organization_id === orgId)
      ?? (!explicitOperatingOrgId ? (operatingContexts ?? []).find((context) => context.is_default === true) : null);
    if (!operatingContext) return json({ error: 'You are not authorized to operate in this organization' }, 403);
    orgId = operatingContext.organization_id;
    if (operatingContext.authority_basis === 'branch_authorisation' && !(operatingContext.module_access ?? []).includes(moduleKey)) return json({ error: 'This module is not authorized for the operating branch' }, 403);
    const manualPlateNumber = typeof manualPlateNumberInput === 'string' ? normalizePlateNumber(manualPlateNumberInput) : '';
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id.trim() : '';
    const fingerprintBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
      image_base64: imageBase64, gps_lat: submittedGpsLat, gps_lng: submittedGpsLng,
      operating_organization_id: orgId, location_id: requestedLocationId, client_site_id: requestedSiteId,
      service_agreement_id: serviceAgreementId, zone_id: expectedWorkingZoneId ?? null,
      location_source: locationSource, module_key: moduleKey, captured_at: capturedAt ?? null
    })));
    const requestFingerprint = Array.from(new Uint8Array(fingerprintBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const completeReceipt = async (response) => {
      if (clientRequestId) {
        const { error: receiptError } = await supabase.from('officer_command_requests').update({ command_status: 'completed', response: { ...response, request_fingerprint: requestFingerprint, recovery_from_fingerprint: recoveryFromFingerprint } }).eq('request_id', clientRequestId).eq('actor_user_id', officerId);
        if (receiptError) console.error('[scan] receipt completion failed:', receiptError.message);
      }
      return json(response);
    };
    if (clientRequestId) {
      const { data: existingReceipt, error: receiptLookupError } = await supabase.from('officer_command_requests').select('command_type, command_status, response, created_at').eq('request_id', clientRequestId).eq('actor_user_id', officerId).maybeSingle();
      if (receiptLookupError) return json({ error: 'Scan request receipt could not be checked' }, 503);
      if (existingReceipt && existingReceipt.response?.request_fingerprint !== requestFingerprint) {
        const original = body.recovery_original_context;
        const unchangedCapture = original && original.client_request_id === clientRequestId
          && original.captured_at === capturedAt && original.module_key === moduleKey
          && original.gps_lat === submittedGpsLat && original.gps_lng === submittedGpsLng
          && (locationSource === 'manual_zone' || (original.location_source ? original.location_source === locationSource : locationSource !== 'device_gps'));
        if (!unchangedCapture || existingReceipt.command_type !== 'process_officer_scan'
          || existingReceipt.command_status !== 'failed' || existingReceipt.response?.retryable !== true
          || existingReceipt.response?.observation_id || existingReceipt.response?.chalk_record_id) {
          return json({ error: 'The saved request cannot be safely resumed automatically. Keep the photo for operations review.', code: 'scan_request_mismatch' }, 409);
        }
        const legacyFingerprints = await Promise.all([...new Set([normalizePlateNumber(original.plate_number ?? ''), manualPlateNumber, ''])].map((plate) => sha256Hex(new TextEncoder().encode(JSON.stringify({
          image_base64: imageBase64, plate_number: plate,
          gps_lat: original.gps_lat, gps_lng: original.gps_lng,
          zone_id: original.zone_id ?? null, module_key: original.module_key, captured_at: original.captured_at ?? null
        })))));
        const originalFingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify({
          image_base64: imageBase64, gps_lat: original.gps_lat, gps_lng: original.gps_lng,
          operating_organization_id: original.operating_organization_id ?? orgId,
          location_id: original.location_id ?? null, client_site_id: original.client_site_id ?? null,
          service_agreement_id: original.service_agreement_id ?? null, zone_id: original.zone_id ?? null,
          location_source: original.location_source ?? (original.zone_id ? 'manual_zone' : 'unavailable'),
          module_key: original.module_key, captured_at: original.captured_at ?? null
        })));
        if (![...legacyFingerprints, originalFingerprint].includes(existingReceipt.response.request_fingerprint)) {
          return json({ error: 'The saved photo or original capture context does not match this request. Keep it for operations review.', code: 'scan_request_mismatch' }, 409);
        }
        if (legacyFingerprints.includes(existingReceipt.response.request_fingerprint) && locationSource === 'device_gps') {
          return json({ error: 'The legacy capture has no confirmed GPS source. Select its Working Zone to recover it without claiming device presence.', code: 'scan_recovery_location_required' }, 409);
        }
        recoveryFromFingerprint = existingReceipt.response.request_fingerprint;
      }
      recoveryFromFingerprint = recoveryFromFingerprint ?? existingReceipt?.response?.recovery_from_fingerprint ?? null;
      captureEvidence = existingReceipt?.response?.capture_evidence ?? null;
      if (existingReceipt?.command_status === 'completed' && existingReceipt.response?.success === true) return json(existingReceipt.response);
      if (existingReceipt) {
        if (existingReceipt.command_status !== 'failed' || existingReceipt.response?.retryable !== true) {
          return json({ error: 'This scan needs recovery before it can be processed again. Keep the saved capture.', code: 'scan_recovery_required', request_id: clientRequestId }, 409);
        }
        const { data: claimed, error: claimError } = await supabase.from('officer_command_requests').update({ command_status: 'processing', response: { ...existingReceipt.response, request_fingerprint: requestFingerprint, recovery_from_fingerprint: recoveryFromFingerprint } })
          .eq('request_id', clientRequestId).eq('actor_user_id', officerId).eq('command_status', 'failed')
          .eq('response->>request_fingerprint', existingReceipt.response.request_fingerprint).select('id').maybeSingle();
        if (claimError || !claimed) return json({ error: 'This scan request is already being processed' }, 409);
      } else {
        const { error: receiptInsertError } = await supabase.from('officer_command_requests').insert({
        request_id: clientRequestId,
        organization_id: actorOrgId,
        actor_user_id: officerId,
        command_type: 'process_officer_scan',
        command_status: 'processing',
        response: { request_fingerprint: requestFingerprint }
      });
      if (receiptInsertError?.code === '23505') return json({ error: 'This scan request is already being processed', request_id: clientRequestId }, 409);
      if (receiptInsertError) return json({ error: 'Scan request receipt could not be created' }, 503);
      }
      requestReceipt = { client: supabase, id: clientRequestId, actorId: officerId, fingerprint: requestFingerprint, owned: true };
      if (recoveryFromFingerprint) {
        const { error: recoveryAuditError } = await supabase.from('audit_log').insert({
          organization_id: orgId, actor_user_id: officerId, action: 'officer_scan_capture_recovered',
          target_table: 'officer_command_requests', target_id: clientRequestId,
          metadata: { original_fingerprint: recoveryFromFingerprint, resumed_fingerprint: requestFingerprint,
            original_capture: { captured_at: capturedAt, gps_lat: submittedGpsLat, gps_lng: submittedGpsLng, module_key: moduleKey } }
        });
        if (recoveryAuditError) return json({ error: 'Saved capture recovery audit could not be confirmed. Keep the photo and retry.', code: 'scan_recovery_audit_failed' }, 503);
      }
    }
    if (!['freedom_camping', 'parking_enforcement'].includes(moduleKey)) return json({
      error: 'Unsupported scan module'
    }, 400);
    if (!imageBase64) return json({
      error: 'Photo evidence is required for this scan. Capture a clear vehicle image for ALPR.'
    }, 400);
    const hasSubmittedLatitude = submittedGpsLat !== null && submittedGpsLat !== undefined;
    const hasSubmittedLongitude = submittedGpsLng !== null && submittedGpsLng !== undefined;
    const hasLatitude = locationSource === 'device_gps' && hasSubmittedLatitude;
    const hasLongitude = locationSource === 'device_gps' && hasSubmittedLongitude;
    const locationContextNeedsReview = !manualZoneId && (!hasLatitude || !hasLongitude);
    if (hasSubmittedLatitude !== hasSubmittedLongitude || hasSubmittedLatitude && (!Number.isFinite(Number(submittedGpsLat)) || !Number.isFinite(Number(submittedGpsLng)) || Number(submittedGpsLat) < -90 || Number(submittedGpsLat) > 90 || Number(submittedGpsLng) < -180 || Number(submittedGpsLng) > 180)) return json({
      error: 'gps_lat and gps_lng must be a complete valid coordinate pair'
    }, 400);
    const gpsLat = hasLatitude ? submittedGpsLat : null;
    const gpsLng = hasLongitude ? submittedGpsLng : null;
    if (profile.role === 'scan_operator') {
      const { data: agreements, error: agreementsError } = await supabase.from('service_agreements').select('id').or(`provider_organization_id.eq.${orgId},client_organization_id.eq.${orgId}`);
      if (agreementsError) return json({
        error: 'Standalone scan access could not be verified'
      }, 503);
      const agreementIds = (agreements ?? []).map((agreement)=>agreement.id);
      if (!agreementIds.length) return json({
        error: 'Standalone scan access is not enabled for this organisation'
      }, 403);
      const { data: moduleAccess, error: moduleAccessError } = await supabase.from('service_agreement_modules').select('id').in('service_agreement_id', agreementIds).eq('module_key', moduleKey).eq('enabled', true).eq('standalone_scan_enabled', true).limit(1);
      if (moduleAccessError) return json({
        error: 'Standalone scan access could not be verified'
      }, 503);
      if (!moduleAccess?.length) return json({
        error: 'Standalone scan access is not enabled for this module'
      }, 403);
    }
    const capturedDate = capturedAt ? new Date(capturedAt) : new Date();
    if (Number.isNaN(capturedDate.getTime())) return json({
      error: 'captured_at must be a valid ISO timestamp'
    }, 400);
    if (capturedDate.getTime() > Date.now() + 5 * 60 * 1000) return json({
      error: 'captured_at cannot be in the future'
    }, 400);
    if (manualZoneId) {
      const { data: canAccessPlace, error: placeAccessError } = await callerClient.rpc('has_location_access', { p_site_id: null, p_zone_id: manualZoneId });
      if (placeAccessError || canAccessPlace !== true) return json({ error: 'Active authority for this Zone could not be confirmed', code: 'scan_place_access_denied' }, 403);
    }
    if (!captureEvidence) {
      const captureBytes = base64ToBytes(imageBase64);
      if (!captureBytes.length || captureBytes.length > 20 * 1024 * 1024) return json({ error: 'Scan photo must be between 1 byte and 20 MB' }, 400);
      const captureBase = `org/${orgId}/scan-captures/${clientRequestId || crypto.randomUUID()}/${crypto.randomUUID()}`;
      const originalPath = `${captureBase}-original.jpg`;
      const watermarkedPath = `${captureBase}-watermarked.jpg`;
      const watermarkText = [
        'Plate pending confirmation',
        `Time ${capturedDate.toISOString()}`,
        expectedWorkingZoneId ? `Working Zone ${expectedWorkingZoneId}` : null,
        `Officer ${officerId}`,
        clientRequestId ? `Request ${clientRequestId}` : null
      ].filter(Boolean).join(' | ');
      const watermarked = await renderWatermarkedEvidence(captureBytes, watermarkText);
      const rawSha256 = await sha256Hex(captureBytes);
      const watermarkedSha256 = await sha256Hex(watermarked);
      const { error: originalUploadError } = await supabase.storage.from(SCAN_BUCKET).upload(originalPath, new Blob([captureBytes], { type: 'image/jpeg' }), { upsert: false, contentType: 'image/jpeg' });
      if (originalUploadError) return json({ error: 'The original scan photo could not be saved. Keep the capture on this device and retry.', code: 'capture_storage_failed' }, 503);
      const { error: watermarkedUploadError } = await supabase.storage.from(SCAN_BUCKET).upload(watermarkedPath, watermarked, { upsert: false, contentType: 'image/jpeg' });
      if (watermarkedUploadError) return json({ error: 'The watermarked scan photo could not be saved. Keep the capture on this device and retry.', code: 'capture_storage_failed' }, 503);
      const { data: captureId, error: captureRegistrationError } = await supabase.rpc('register_edge_court_photo', {
        p_organization_id: orgId, p_module_key: moduleKey, p_storage_path: watermarkedPath,
        p_captured_at: capturedDate.toISOString(),
        p_metadata: {
          original_path: originalPath, raw_sha256: rawSha256, watermarked_sha256: watermarkedSha256,
          watermark_text: watermarkText, watermark_service: 'inference', request_id: clientRequestId || null,
          captured_by_user_id: officerId, capture_state: 'awaiting_plate_confirmation', source: 'submitted_scan_image',
          operating_organization_id: orgId, location_id: requestedLocationId, client_site_id: requestedSiteId,
          service_agreement_id: serviceAgreementId, working_zone_id: expectedWorkingZoneId ?? null,
          location_source: locationSource, processed_observation_created: false
        }
      });
      if (captureRegistrationError || !captureId) return json({ error: 'The photo upload completed but its evidence registration was not confirmed. Keep the capture for review.', code: 'capture_registration_failed' }, 503);
      captureEvidence = { evidence_id: captureId, storage_path: watermarkedPath, original_path: originalPath, raw_sha256: rawSha256, watermarked_sha256: watermarkedSha256, watermark_text: watermarkText };
    }
    if (locationContextNeedsReview || locationSource === 'address_candidate' && !hasSubmittedLatitude) return json({
      error: 'Photo saved. A manual Zone or complete GPS coordinates are required with confirmed location source.',
      code: 'location_confirmation_required'
    }, 400);
    // Steps 3 & 4: ALPR + full inference in parallel (same photo, two calls).
    // An officer-entered plate is the governed fallback when ALPR cannot read the image.
    let alprResult = null;
    let inferResult = null;
    let alprUsed = false;
    if (imageBase64) {
      [alprResult, inferResult] = await Promise.all([
        manualPlateNumber ? Promise.resolve(null) : runAlpr(imageBase64),
        runInference(imageBase64)
      ]);
      if (!manualPlateNumber && (!alprResult?.plate || alprResult.confidence < MIN_ALPR_CONFIDENCE)) {
        const fallbackResult = await runPlateRecognizerAlpr(imageBase64);
        if (fallbackResult?.plate && fallbackResult.confidence >= MIN_ALPR_CONFIDENCE) {
          alprResult = fallbackResult;
        }
      }
      alprUsed = alprResult !== null;
    }
    const plateNumber = manualPlateNumber || (alprResult?.confidence >= MIN_ALPR_CONFIDENCE ? normalizePlateNumber(alprResult?.plate ?? '') : '');
    if (!plateNumber) return json({
      error: 'Photo saved. A plate could not be confirmed. Confirm the plate manually, or capture a clearer image.',
      code: 'plate_confirmation_required'
    }, 400);
    const plateConfidence = manualPlateNumber ? null : alprResult?.confidence ?? null;
    const plateSource = manualPlateNumber ? 'manual' : 'alpr';
    const alprProvider = manualPlateNumber ? null : alprResult?.provider ?? null;
    console.log(`[scan] plate=${plateNumber} source=${plateSource} org=${orgId}`);
    // Step 5: Geofence resolution from GPS via resolve_operational_context().
    // It preserves direct-org resolution and adds accepted contracted places.
    // operating bounds -> governing jurisdiction -> site geofence + zone).
    // resolve_context RETURNS TABLE; read the single row. (The old
    // get_zone_for_gps call cast a table result to a scalar, so GPS zone
    // detection silently always returned null — see docs/GEOFENCE_ARCHITECTURE.md.)
    let zoneId = manualZoneId ?? null;
    let zoneName = null;
    let locationId = null;
    let siteId = null;
    let clientOrgId = null;
    let onSite = null;
    let inOperatingBounds = null;
    let outOfBoundsDistrict = null;
    let effectiveRules = null;
    let zoneClosure = null;
    // GEOFENCE_PRINCIPLES P1: the five resolver outcomes are distinct answers and are
    // never collapsed into "no zone". Rules apply only when 'resolved'; every other
    // outcome is recorded on the observation and said loudly to the officer.
    let resolutionStatus = hasLatitude && hasLongitude ? null : 'not_evaluated';
    let governorOverlapFlag = false;
    if (!zoneId && hasLatitude && hasLongitude) {
      const { data: ctxRows, error: contextError } = await callerClient.rpc('resolve_operational_context_authorized', {
        p_lat: Number(gpsLat),
        p_lng: Number(gpsLng),
        p_org_id: orgId,
        p_module_key: moduleKey ?? null,
        p_at: capturedDate.toISOString()
      });
      if (contextError) return json({
        error: 'Geofence context could not be resolved',
        detail: contextError.message
      }, 503);
      const ctx = Array.isArray(ctxRows) ? ctxRows[0] : ctxRows;
      // Fail closed: an absent row is an infrastructure fault, not "outside all geofences".
      if (!ctx) return json({ error: 'Geofence context could not be resolved', detail: 'resolver returned no row' }, 503);
      zoneId = ctx.matched_zone_id ?? null;
      if (expectedWorkingZoneId && zoneId !== expectedWorkingZoneId) return json({ error: 'Device location does not resolve to the selected Working Zone', code: 'working_zone_mismatch', capture_saved: Boolean(captureEvidence), request_id: clientRequestId || null }, 409);
      siteId = ctx.site_id ?? null;
      clientOrgId = ctx.client_org_id ?? null;
      onSite = typeof ctx.on_site === 'boolean' ? ctx.on_site : null;
      inOperatingBounds = typeof ctx.in_operating_bounds === 'boolean' ? ctx.in_operating_bounds : null;
      outOfBoundsDistrict = ctx.out_of_bounds_district ?? null;
      effectiveRules = ctx.effective_rules ?? null;
      resolutionStatus = typeof ctx.resolution_status === 'string' && ctx.resolution_status ? ctx.resolution_status : 'unresolved_no_geofence';
      governorOverlapFlag = ctx.governor_overlap_flag === true;
      if (resolutionStatus !== 'resolved' && (zoneId || siteId)) {
        // The resolver only matches verified geometry; a match with a non-resolved status would be a contract break.
        console.error(`[scan] resolver contract break: status=${resolutionStatus} with zone=${zoneId ?? 'none'} site=${siteId ?? 'none'}`);
        return json({ error: 'Geofence context could not be resolved', detail: `inconsistent resolution (${resolutionStatus})` }, 503);
      }
      console.log(`[scan] resolve_operational_context status=${resolutionStatus} zone=${zoneId ?? 'none'} on_site=${onSite} in_bounds=${inOperatingBounds} governor_overlap=${governorOverlapFlag}`);
    }
    const geofenceNotice = GEOFENCE_NOTICE[resolutionStatus ?? 'unresolved_no_geofence'] ?? null;
    if (geofenceNotice) console.warn(`[scan] geofence ${resolutionStatus}: ${geofenceNotice}`);
    if (zoneId) {
      // Lightweight fetch for the zone name (used in the evidence watermark) and
      // location_id; site_id already came from resolve_context.
      const { data: canAccessPlace, error: placeAccessError } = await callerClient.rpc('has_location_access', { p_site_id: siteId, p_zone_id: zoneId });
      if (placeAccessError || canAccessPlace !== true) return json({ error: 'Active authority for the resolved place could not be confirmed', code: 'scan_place_access_denied' }, 403);
      const zoneQuery = supabase.from('location_zones').select('id, name, location_id, module_key, active_schedule, boundary_verification, organization_id').eq('id', zoneId).eq('is_active', true);
      const { data: zoneData, error: zoneError } = await zoneQuery.maybeSingle();
      if (zoneError) return json({ error: 'Zone context could not be loaded', detail: zoneError.message }, 503);
      if (!zoneData || zoneData.boundary_verification !== 'verified') return json({ error: 'An active verified Zone in this organization is required' }, 409);
      if (moduleKey && zoneData.module_key && zoneData.module_key !== moduleKey) return json({ error: 'Selected Zone does not support this scan module' }, 409);
      if (serviceAgreementId) {
        const [agreementResult, agreementPlaceResult, agreementModuleResult] = await Promise.all([
          supabase.from('service_agreements').select('provider_organization_id, agreement_type, starts_on, ends_on').eq('id', serviceAgreementId).maybeSingle(),
          supabase.from('service_agreement_locations').select('id').eq('service_agreement_id', serviceAgreementId).eq('zone_id', zoneId).eq('status', 'active').maybeSingle(),
          supabase.from('service_agreement_modules').select('id').eq('service_agreement_id', serviceAgreementId).eq('module_key', moduleKey).eq('enabled', true).maybeSingle()
        ]);
        if (agreementResult.error || agreementPlaceResult.error || agreementModuleResult.error) return json({ error: 'Service agreement scope could not be verified' }, 503);
        const agreement = agreementResult.data;
        const captureDay = capturedDate.toISOString().slice(0, 10);
        if (!agreement || agreement.provider_organization_id !== orgId || agreement.agreement_type !== 'operational' || agreement.starts_on && agreement.starts_on > captureDay || agreement.ends_on && agreement.ends_on < captureDay || !agreementPlaceResult.data || !agreementModuleResult.data) return json({ error: 'The selected agreement is not active for this operating organization, module and Working Zone', code: 'scan_agreement_context_mismatch' }, 403);
      }
      if (manualZoneId) {
        const { data: scheduleActive, error: scheduleError } = await supabase.rpc('_geofence_active_at', { p_schedule: zoneData.active_schedule, p_at: capturedDate.toISOString() });
        if (scheduleError) return json({ error: 'Zone schedule could not be resolved', detail: scheduleError.message }, 503);
        if (scheduleActive !== true) return json({ error: 'Selected Zone is not active at the capture time' }, 409);
      }
      zoneName = zoneData.name;
      locationId = zoneData.location_id;
      if (requestedLocationId && requestedLocationId !== locationId) return json({ error: 'Selected Working Zone does not belong to the requested House location', code: 'scan_place_context_mismatch' }, 409);
      if (requestedSiteId) {
        const { data: selectedSite, error: selectedSiteError } = await supabase.from('client_sites').select('id').eq('id', requestedSiteId).eq('location_id', locationId).eq('active', true).maybeSingle();
        if (selectedSiteError) return json({ error: 'Selected Site context could not be verified' }, 503);
        if (!selectedSite) return json({ error: 'Selected Site and Working Zone do not share the requested House location', code: 'scan_place_context_mismatch' }, 409);
        siteId = selectedSite.id;
      }
      if (!clientOrgId && locationId) {
        const { data: house, error: houseError } = await supabase.from('locations').select('organization_id').eq('id', locationId).single();
        if (houseError || !house) return json({ error: 'Place ownership could not be confirmed' }, 503);
        clientOrgId = house.organization_id;
      }
      if (!siteId && locationId) {
        // Manual zone selection skipped the resolver: the site is the zone's sibling on the same house.
        const { data: siblingSite } = await supabase.from('client_sites').select('id').eq('location_id', locationId).eq('active', true).order('created_at').limit(1).maybeSingle();
        siteId = siblingSite?.id ?? null;
      }
      const { data: closureData, error: closureError } = await supabase.rpc('is_zone_closed', {
        p_zone_id: zoneId,
        p_at: capturedDate.toISOString()
      });
      if (closureError) return json({
        error: 'Zone closure state could not be resolved',
        detail: closureError.message
      }, 503);
      zoneClosure = closureData ?? null;
    }
    const geofenceContext = {
      resolved_at: capturedDate.toISOString(),
      resolution_source: locationSource === 'device_gps' ? 'resolve_operational_context_authorized' : locationSource,
      location_source: locationSource,
      candidate_coordinates: locationSource === 'address_candidate' ? { lat: submittedGpsLat, lng: submittedGpsLng } : null,
      spatial_resolution_evaluated: locationSource === 'device_gps' && hasLatitude && hasLongitude,
      resolution_status: resolutionStatus,
      governor_overlap_flag: governorOverlapFlag,
      geofence_notice: geofenceNotice,
      zone_id: zoneId,
      site_id: siteId,
      location_id: locationId,
      client_org_id: clientOrgId,
      on_site: onSite,
      in_operating_bounds: inOperatingBounds,
      out_of_bounds_district: outOfBoundsDistrict,
      effective_rules: effectiveRules,
      closure: zoneClosure ?? { closed: false }
    };
    // ── PARKING ENFORCEMENT BRANCH ──────────────────────────────────────────
    // When module_key === 'parking_enforcement', run the parking-specific
    // pipeline (steps 6P–12P) and early-return. The FC-specific steps 6–12
    // below are skipped entirely for parking scans.
    // Issue #116.
    if (moduleKey === 'parking_enforcement') {
      // Step 6P: Parking lookups (parallel)
      const [parkingVehicleRes, parkingChalkRes, _parkingZoneRulesRes, _parkingModuleConfigRes, parkingOfficerRes] = await Promise.all([
        // a. canonical_vehicles lookup (same as FC — VOI/flags + rego/WoF/CoF compliance)
        supabase.from('canonical_vehicles').select('id, make, model, year, colour, rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry, compliance_checked_at').eq('plate_number', plateNumber).maybeSingle(),
        // b. Most recent active chalk record for this plate in this zone/org
        supabase.from('parking_chalk_records').select('id, chalked_at, return_by, status, embedding, photo_url, photo_urls, zone_id').eq('organization_id', orgId).eq('plate', plateNumber).eq('zone_id', zoneId).eq('status', 'active').order('chalked_at', {
          ascending: true
        }).limit(1).maybeSingle(),
        // c. Zone parking rules from location_zones
        zoneId ? supabase.from('location_zones').select('parking_time_limit_minutes, parking_disabled_multiplier, parking_signage_photo_url').eq('id', zoneId).single() : Promise.resolve({
          data: null
        }),
        // d. parking_module_config for org defaults
        supabase.from('parking_module_config').select('default_time_limit_minutes, grace_period_minutes').eq('organization_id', orgId).maybeSingle(),
        // e. Officer display name for chalk record
        supabase.from('user_profiles').select('display_name').eq('id', officerId).single()
      ]);
      const parkingVehicle = parkingVehicleRes.data;
      const priorChalk = parkingChalkRes.data;
      const zoneParkingRule = _parkingZoneRulesRes.data;
      if (parkingChalkRes.error || _parkingZoneRulesRes.error) return json({ error: 'Photo saved, but Parking history or rules could not be loaded.', code: 'parking_policy_unavailable' }, 503);
      if (!zoneId || resolutionStatus !== 'resolved' || !zoneParkingRule?.parking_signage_photo_url || !Number.isInteger(zoneParkingRule.parking_time_limit_minutes) || zoneParkingRule.parking_time_limit_minutes <= 0) {
        return json({ error: 'Photo saved. A verified Parking Zone with a source-backed time limit is required before chalk timing can start.', code: 'parking_rule_review_required' }, 422);
      }
      const parkingOfficerName = parkingOfficerRes.data?.display_name ?? null;
      const parkingSafetyWarnings = await loadSafetyWarnings(supabase, parkingVehicle?.id ?? null, orgId);
      // Merge vehicle attributes: inference > canonical > null
      const pVehicleMake = inferResult?.vehicle_make ?? parkingVehicle?.make ?? null;
      const pVehicleModel = inferResult?.vehicle_model ?? parkingVehicle?.model ?? null;
      const pVehicleColour = inferResult?.vehicle_colour ?? parkingVehicle?.colour ?? null;
      let parkingScene = null;
      if (imageBase64) {
        const sceneTempPath = `org/${orgId}/parking-scene-temp/${crypto.randomUUID()}.jpg`;
        try {
          // Upload photo to storage for a signed URL, then call classify-parking-scene
          const sceneBytes = base64ToBytes(imageBase64);
          await supabase.storage.from(SCAN_BUCKET).upload(sceneTempPath, new Blob([
            sceneBytes
          ], {
            type: 'image/jpeg'
          }), {
            upsert: true,
            contentType: 'image/jpeg'
          });
          const { data: signedUrlData } = await supabase.storage.from(SCAN_BUCKET).createSignedUrl(sceneTempPath, 300); // 5 min expiry
          const photoUrl = signedUrlData?.signedUrl;
          if (photoUrl) {
            const classifyUrl = `${SUPABASE_URL}/functions/v1/classify-parking-scene`;
            const classifyController = new AbortController();
            const classifyTimeout = setTimeout(()=>classifyController.abort(), 30_000);
            const classifyRes = await fetch(classifyUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
              },
              body: JSON.stringify({
                photo_url: photoUrl,
                context: `Plate: ${plateNumber}, Zone: ${zoneName ?? 'unknown'}`
              }),
              signal: classifyController.signal
            });
            clearTimeout(classifyTimeout);
            if (classifyRes.ok) {
              const classifyData = await classifyRes.json();
              if (classifyData.success && classifyData.data) {
                parkingScene = classifyData.data;
              }
            } else {
              console.warn(`[scan:parking] classify-parking-scene HTTP ${classifyRes.status}`);
            }
          }
        } catch (sceneErr) {
          console.warn(`[scan:parking] classify-parking-scene error: ${sceneErr instanceof Error ? sceneErr.message : String(sceneErr)}`);
        }
        // Cleanup temp photo (non-blocking)
        try {
          await supabase.storage.from(SCAN_BUCKET).remove([
            sceneTempPath
          ]);
        } catch (_cleanupErr) {
        // Non-blocking: ignore cleanup errors
        }
      }
      console.log(`[scan:parking] scene: marking=${parkingScene?.road_marking_detected ?? 'unknown'} disabled_bay=${parkingScene?.is_disabled_bay ?? false} sign_limit=${parkingScene?.sign_time_limit_minutes ?? 'none'}`);
      // Step 6dP: Vehicle compliance check (rego/WoF/CoF)
      const today = new Date().toISOString().slice(0, 10);
      const regoExpiry = parkingVehicle?.rego_expiry;
      const wofExpiry = parkingVehicle?.wof_expiry;
      const cofExpiry = parkingVehicle?.cof_expiry;
      const complianceCheckedAt = parkingVehicle?.compliance_checked_at;
      // Determine if MotoWeb lookup needed (unknown status or stale > 30 days)
      const isStale = complianceCheckedAt ? Date.now() - new Date(complianceCheckedAt).getTime() > 30 * 24 * 60 * 60 * 1000 : true;
      const needsLookup = !parkingVehicle || isStale || parkingVehicle.rego_status === 'unknown' || parkingVehicle.rego_status == null;
      let regoStatus = parkingVehicle?.rego_status ?? 'unknown';
      let wofStatus = parkingVehicle?.wof_status ?? 'unknown';
      let cofStatus = parkingVehicle?.cof_status ?? 'unknown';
      if (needsLookup && plateNumber) {
        try {
          const motowebUrl = `${SUPABASE_URL}/functions/v1/motoweb-vehicle-lookup`;
          const motowebRes = await fetch(motowebUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            body: JSON.stringify({
              plate: plateNumber
            }),
            signal: AbortSignal.timeout(15_000)
          });
          if (motowebRes.ok) {
            const motowebData = await motowebRes.json();
            regoStatus = motowebData.rego_status ?? 'unknown';
            wofStatus = motowebData.wof_status ?? 'unknown';
            cofStatus = motowebData.cof_status ?? 'unknown';
          }
        } catch (motowebErr) {
          console.warn(`[scan:parking] motoweb lookup failed: ${motowebErr instanceof Error ? motowebErr.message : String(motowebErr)}`);
        }
      }
      // Build compliance flags
      const vehicleComplianceFlags = [];
      if (regoStatus === 'expired') vehicleComplianceFlags.push('expired_rego');
      if (wofStatus === 'expired') vehicleComplianceFlags.push('expired_wof');
      if (cofStatus === 'expired') vehicleComplianceFlags.push('expired_cof');
      console.log(`[scan:parking] compliance: rego=${regoStatus} wof=${wofStatus} cof=${cofStatus} flags=${vehicleComplianceFlags.join(',') || 'none'}`);
      void today; // used for reference; expiry comparison done by motoweb
      // Step 7P: Movement detection (IDENTICAL to FC)
      // Compare new embedding with prior chalk record embedding
      let parkingMovement = null;
      const priorChalkEmbedding = priorChalk?.embedding;
      const parkingNewEmbedding = inferResult?.embedding ?? null;
      if (parkingNewEmbedding && priorChalkEmbedding) {
        parkingMovement = await runMovementCheck(parkingNewEmbedding, priorChalkEmbedding, imageBase64, priorChalk?.photo_url, supabase);
        console.log(`[scan:parking] movement: ${parkingMovement?.decision ?? 'skipped'}`);
      }
      // If moved: update prior chalk record to status='compliant'
      if (parkingMovement?.moved && priorChalk?.id) {
        safeToRetry = false;
        const { error: movementWriteError } = await supabase.from('parking_chalk_records').update({
          status: 'compliant',
          resolved_at: new Date().toISOString()
        }).eq('id', priorChalk.id);
        if (movementWriteError) throw new Error('The previous parking session could not be closed.');
        console.log(`[scan:parking] prior chalk ${priorChalk.id} marked compliant (vehicle moved)`);
      }
      let parkingCompliance = {
        verdict: 'unknown',
        effective_limit_minutes: zoneParkingRule.parking_time_limit_minutes,
        grace_period_minutes: 0,
        chalked_at: null,
        minutes_elapsed: null,
        is_overstay: false,
        is_repeat: false,
        repeat_count: 0,
        recommended_action: 'review_required'
      };
      // Only run compliance if vehicle did NOT move (moved = compliant, no need to check)
      if (!parkingMovement?.moved) {
        const { data: compData, error: compErr } = await supabase.rpc('evaluate_parking_compliance', {
          p_org_id: orgId,
          p_zone_id: zoneId,
          p_plate: plateNumber,
          p_is_disabled_bay: parkingScene?.is_disabled_bay === true,
          p_sign_time_limit_minutes: null
        });
        if (compErr || !compData || !Number.isFinite(compData.effective_limit_minutes) || compData.effective_limit_minutes <= 0) return json({ error: 'Photo saved, but the Parking policy result was not confirmed.', code: 'parking_policy_unavailable' }, 503);
        parkingCompliance = compData;
        if (parkingCompliance.is_overstay && (!parkingScene || parkingMovement?.decision !== 'stationary')) {
          parkingCompliance = { ...parkingCompliance, verdict: 'unknown', is_overstay: false, recommended_action: 'review_required' };
        }
      }
      console.log(`[scan:parking] compliance: verdict=${parkingCompliance.verdict} overstay=${parkingCompliance.is_overstay} repeat=${parkingCompliance.is_repeat}`);
      // Step 9P: Write parking_chalk_records
      const effectiveLimitMinutes = parkingCompliance.effective_limit_minutes;
      const effectiveLimitMs = effectiveLimitMinutes * 60 * 1000;
      // C5 fix: use a single timestamp for both chalked_at and return_by
      // to avoid drift between separate Date.now() calls.
      const parkingNowMs = capturedDate.getTime();
      const parkingObservedAt = new Date(parkingNowMs).toISOString();
      safeToRetry = false;
      const reuseChalk = priorChalk && !parkingMovement?.moved;
      const { data: chalkData, error: chalkErr } = reuseChalk ? { data: { id: priorChalk.id }, error: null } : await supabase.from('parking_chalk_records').insert({
        organization_id: orgId,
        plate: plateNumber,
        zone_id: zoneId,
        client_site_id: siteId,
        location_name: zoneName,
        chalked_at: parkingObservedAt,
        return_by: new Date(parkingNowMs + effectiveLimitMs).toISOString(),
        status: 'active',
        officer_id: officerId,
        officer_name: parkingOfficerName,
        embedding: parkingNewEmbedding,
        embedding_quality: inferResult?.embedding_quality ?? null,
        movement_detected: parkingMovement?.moved ?? null,
        movement_similarity: parkingMovement?.similarity ?? null,
        is_disabled_bay: parkingScene?.is_disabled_bay ?? null,
        road_marking_detected: parkingScene?.road_marking_detected ?? 'unknown',
        sign_time_limit_minutes: parkingScene?.sign_time_limit_minutes ?? null,
        sign_confidence: parkingScene?.sign_confidence ?? null,
        effective_time_limit_minutes: effectiveLimitMinutes,
        inference_provider: 'classify_parking_scene',
        vehicle_make: pVehicleMake,
        vehicle_model: pVehicleModel,
        vehicle_colour: pVehicleColour,
        rego_status: regoStatus,
        rego_expiry: regoExpiry ?? null,
        wof_status: wofStatus,
        wof_expiry: wofExpiry ?? null,
        cof_status: cofStatus,
        cof_expiry: cofExpiry ?? null,
        vehicle_compliance_flags: vehicleComplianceFlags.length > 0 ? vehicleComplianceFlags : null
        ,geofence_context: geofenceContext
      }).select('id').single();
      if (chalkErr || !chalkData) {
        return json({
          error: 'Failed to record parking chalk',
          detail: chalkErr?.message
        }, 500);
      }
      const chalkRecordId = chalkData.id;
      // Step 9bP: Evidence photos (same pattern as FC)
      const parkingEvidence = await attachScanEvidence(supabase, captureEvidence, {
        orgId,
        officerId,
        moduleKey: 'parking_enforcement',
        recordType: 'parking_chalk_record',
        recordId: chalkRecordId,
        clientRequestId
      });
      if (parkingEvidence.originalPath || parkingEvidence.watermarkedPath) {
        const { error: photoLinkError } = await supabase.from('parking_chalk_records').update({
          photo_url: reuseChalk ? priorChalk.photo_url ?? parkingEvidence.watermarkedPath : parkingEvidence.watermarkedPath ?? parkingEvidence.originalPath,
          photo_urls: [...(reuseChalk && Array.isArray(priorChalk.photo_urls) ? priorChalk.photo_urls : []), { storage_path: parkingEvidence.watermarkedPath, captured_at: parkingObservedAt, raw_sha256: parkingEvidence.rawSha256, watermarked_sha256: parkingEvidence.watermarkedSha256 }]
        }).eq('id', chalkRecordId);
        if (photoLinkError) throw new Error('The parking scan photo linkage was not confirmed.');
      }
      // Step 10P: Create breach alert if overstay
      // #162 fix: plain insert + unique-violation (23505) handling.
      // The partial unique index idx_breach_alerts_parking_dedup
      // cannot be inferred as an ON CONFLICT arbiter from a column list
      // alone (Postgres 42P10), so the previous upsert always failed silently.
      let parkingBreachAlertId = null;
      let parkingBreachWriteError = null;
      if (parkingCompliance.is_overstay) {
        const breachType = parkingCompliance.is_repeat ? 'parking_repeat_overstay' : 'parking_overstay';
        const { data: breachData, error: breachInsertErr } = await supabase.from('breach_alerts').insert({
          organization_id: orgId,
          zone_id: zoneId,
          plate_number: plateNumber,
          breach_type: breachType,
          nights_count: null,
          limit_value: effectiveLimitMinutes,
          status: 'open',
          client_org_id: clientOrgId ?? null
        }).select('id').single();
        if (!breachInsertErr) {
          parkingBreachAlertId = breachData?.id;
        } else if (breachInsertErr.code === '23505') {
          // Duplicate: an active breach already exists for this plate+zone+type.
          const { data: existingBreach } = await supabase.from('breach_alerts').select('id').eq('organization_id', orgId).eq('plate_number', plateNumber).eq('zone_id', zoneId).eq('breach_type', breachType).in('status', [
            'open',
            'acknowledged',
            'actioned'
          ]).maybeSingle();
          parkingBreachAlertId = existingBreach?.id;
        } else {
          console.error('[scan:parking] breach_alerts insert failed (Step 10P):', breachInsertErr.code, breachInsertErr.message, breachInsertErr.details);
          parkingBreachWriteError = `Parking breach insert failed: ${breachInsertErr.code} ${breachInsertErr.message}`;
        }
        if (parkingBreachAlertId) {
          console.log(`[scan:parking] breach alert ${parkingBreachAlertId}`);
        }
      }
      // Create breach alerts for expired rego/WoF/CoF (separate from overstay)
      // #162 fix: plain insert + unique-violation (23505) handling.
      // Same root cause as Step 10P — partial unique index cannot be
      // inferred as an ON CONFLICT arbiter.
      for (const flag of vehicleComplianceFlags.filter(() => Boolean(zoneId && resolutionStatus === 'resolved'))){
        const breachType = flag === 'expired_rego' ? 'expired_rego' : flag === 'expired_wof' ? 'expired_wof' : 'expired_cof';
        const { error: vcBreachErr } = await supabase.from('breach_alerts').insert({
          organization_id: orgId,
          zone_id: zoneId,
          plate_number: plateNumber,
          breach_type: breachType,
          nights_count: null,
          limit_value: null,
          status: 'open',
          client_org_id: clientOrgId ?? null
        });
        if (vcBreachErr && vcBreachErr.code !== '23505') {
          // 23505 = duplicate, expected and safe to ignore.
          // Any other error is unexpected — log it.
          console.error(`[scan:parking] breach_alerts insert failed (vehicle compliance ${breachType}):`, vcBreachErr.code, vcBreachErr.message, vcBreachErr.details);
          if (!parkingBreachWriteError) {
            parkingBreachWriteError = `Vehicle compliance breach insert failed (${breachType}): ${vcBreachErr.code} ${vcBreachErr.message}`;
          }
        }
      }
      // Step 11P: GPS log (non-blocking, same pattern as FC)
      if (gpsLat !== null && gpsLng !== null) {
        supabase.from('officer_gps_log').insert({
          organization_id: orgId,
          officer_id: officerId,
          gps_lat: gpsLat,
          gps_lng: gpsLng,
          detected_zone_id: zoneId,
          activity_type: 'scan'
        }).then(()=>{});
      }
      // Step 12P: Return parking verdict
      return completeReceipt({
        success: true,
        // Parking-specific fields
        verdict: parkingCompliance.verdict,
        plate: plateNumber,
        plate_number: plateNumber,
        plate_confidence: plateConfidence,
        alpr_used: alprUsed,
        alpr_provider: alprProvider,
        plate_source: plateSource,
        effective_limit_minutes: parkingCompliance.effective_limit_minutes,
        grace_period_minutes: parkingCompliance.grace_period_minutes,
        chalked_at: parkingCompliance.chalked_at,
        minutes_elapsed: parkingCompliance.minutes_elapsed,
        is_overstay: parkingCompliance.is_overstay,
        is_disabled_bay: parkingScene?.is_disabled_bay ?? false,
        road_marking: parkingScene?.road_marking_detected ?? 'unknown',
        recommended_action: parkingCompliance.recommended_action,
        is_repeat: parkingCompliance.is_repeat,
        repeat_count: parkingCompliance.repeat_count,
        // Movement detection
        movement_moved: parkingMovement?.moved ?? null,
        movement_similarity: parkingMovement?.similarity ?? null,
        movement_decision: parkingMovement?.decision ?? null,
        // Vehicle attributes
        vehicle_make: pVehicleMake,
        vehicle_model: pVehicleModel,
        vehicle_colour: pVehicleColour,
        make: pVehicleMake,
        model: pVehicleModel,
        colour: pVehicleColour,
        // Vehicle compliance
        rego_status: regoStatus,
        wof_status: wofStatus,
        cof_status: cofStatus,
        vehicle_compliance_flags: vehicleComplianceFlags,
        safety_warnings: parkingSafetyWarnings,
        // Geofence context
        zone_id: zoneId,
        zone_name: zoneName,
        on_site: onSite,
        in_operating_bounds: inOperatingBounds,
        out_of_bounds_district: outOfBoundsDistrict,
        effective_rules: effectiveRules,
        resolution_status: resolutionStatus,
        governor_overlap_flag: governorOverlapFlag,
        geofence_notice: geofenceNotice,
        zone_closed: zoneClosure?.closed === true,
        zone_closure: zoneClosure,
        // Record IDs
        chalk_record_id: chalkRecordId,
        breach_alert_id: parkingBreachAlertId,
        // FC-compatible fields for PatrolPage
        compliance_status: parkingCompliance.verdict === 'clear' || parkingCompliance.verdict === 'watch' ? 'compliant' : 'non_compliant',
        breach_type: parkingCompliance.is_overstay ? 'parking_overstay' : null,
        breach_created: parkingBreachAlertId !== null,
        alpr_confidence: plateConfidence,
        // Module context
        module_key: moduleKey,
        ...parkingBreachWriteError ? {
          breach_write_error: parkingBreachWriteError
        } : {}
      });
    }
    // ── END PARKING ENFORCEMENT BRANCH ──────────────────────────────────────
    // Step 6: Canonical lookups + previous observation + org settings (all parallel)
    const [vehicleRes, scvRes, homelessRes, prevObsRes, orgSettingsRes] = await Promise.all([
      supabase.from('canonical_vehicles').select('id, make, model, year, colour').eq('plate_number', plateNumber).maybeSingle(),
      // Canonical SCV CSV is the primary lookup source. Treat only active,
      // unexpired certificates as valid; expired records remain useful audit data
      // but must not mark a vehicle compliant.
      supabase.from('canonical_scv').select('certificate_number, certificate_status, expiry_date').eq('plate_number', plateNumber).eq('certificate_status', 'active').or(`expiry_date.is.null,expiry_date.gte.${new Date().toISOString().slice(0, 10)}`).maybeSingle(),
      supabase.from('canonical_homeless').select('status, support_agency').eq('plate_number', plateNumber).in('status', [
        'homeless',
        'welfare_referral'
      ]).maybeSingle(),
      // Fetch previous observation embedding + observed_at for movement detection.
      // observed_at is needed by the single_daily_observation path to determine
      // calendar-day adjacency (consecutive-day pair → inferred overnight).
      zoneId ? supabase.from('observations').select('id, embedding, observed_at, original_photo_url').eq('plate_number', plateNumber).eq('zone_id', zoneId).eq('organization_id', orgId).order('observed_at', {
        ascending: false
      }).limit(1).maybeSingle() : Promise.resolve({
        data: null
      }),
      // Fetch org verification_mode from freedom_camping_org_settings (0191).
      // Default two_photo_verified if no row exists (backward-compatible).
      supabase.from('freedom_camping_org_settings').select('verification_mode').eq('organization_id', orgId).eq('is_current', true).maybeSingle()
    ]);
    const vehicle = vehicleRes.data;
    const safetyWarnings = await loadSafetyWarnings(supabase, vehicle?.id ?? null, orgId);
    const scv = scvRes.data;
    const homeless = homelessRes.data;
    const prevObs = prevObsRes.data;
    const verificationMode = orgSettingsRes.data?.verification_mode === 'single_daily_observation' ? 'single_daily_observation' : 'two_photo_verified';
    // Merge vehicle attributes: inference → canonical → null
    const vehicleMake = inferResult?.vehicle_make ?? vehicle?.make ?? null;
    const vehicleModel = inferResult?.vehicle_model ?? vehicle?.model ?? null;
    const vehicleColour = inferResult?.vehicle_colour ?? vehicle?.colour ?? null;
    const isScv = scv !== null;
    const isHomeless = homeless !== null;
    const scvCertNumber = scv?.certificate_number ?? null;
    // Step 7: Movement detection
    let movementResult = null;
    const prevEmbedding = prevObs?.embedding;
    const newEmbedding = inferResult?.embedding ?? null;
    if (newEmbedding && prevEmbedding && prevObs) {
      movementResult = await runMovementCheck(newEmbedding, prevEmbedding, imageBase64, prevObs.original_photo_url, supabase);
      console.log(`[scan] movement: ${movementResult?.decision ?? 'skipped'}`);
    }
    // Step 7a: Classify overnight window + peek at existing session (read-only).
    // MUST run before Step 8 so calculate_vehicle_compliance (0193/0195) sees the
    // correct verified-session state when it counts nights.
    // BRANCHED on verificationMode (0191):
    //   two_photo_verified       → classifyOvernightWindow (local-midnight split)
    //   single_daily_observation → peekSingleDailyObservation (calendar-day adjacency)
    const observedAt = capturedDate.toISOString();
    console.log(`[scan] verificationMode=${verificationMode}`);
    let windowPeek = {
      scanWindow: null,
      overnightDate: null,
      existingSessionId: null,
      priorVerificationStatus: null
    };
    let singleDailyPeek = null;
    if (verificationMode === 'single_daily_observation') {
      singleDailyPeek = peekSingleDailyObservation(supabase, orgId, plateNumber, zoneId, observedAt, prevObs ? {
        id: prevObs.id,
        observed_at: prevObs.observed_at
      } : null, movementResult);
      console.log(`[scan] single_daily: overnightDate=${singleDailyPeek.overnightDate ?? 'none'} inferred=${singleDailyPeek.inferredVerificationStatus ?? 'none'}`);
    } else {
      windowPeek = await classifyOvernightWindow(supabase, orgId, plateNumber, zoneId, observedAt);
      console.log(`[scan] window=${windowPeek.scanWindow ?? 'none'} date=${windowPeek.overnightDate ?? 'none'} prior=${windowPeek.priorVerificationStatus ?? 'none'}`);
    }
    safeToRetry = false;
    // Step 8: Compliance check -- now runs AFTER the session row exists, so
    // calculate_vehicle_compliance (0193) correctly counts this morning's
    // verified overnight when deciding the verdict.
    let compliance = {
      is_compliant: null,
      reason: zoneId ? 'pending_overnight_evaluation' : 'no_zone_configured',
      nights_this_zone: 0,
      nights_this_month: 0,
      limit_consecutive: null,
      limit_monthly: null,
      scv_required: false,
      is_scv: isScv
    };
    // Homeless: check for a CONFIRMED homeless_claims record (0191).
    // Unlike the old silent override, we now record the true rule verdict and
    // set enforcement_exempt instead of force-flipping is_compliant.
    let enforcementExempt = false;
    let exemptionReason = null;
    if (isHomeless) {
      const { data: confirmedClaim } = await supabase.from('homeless_claims').select('id').eq('plate_number', plateNumber).eq('status', 'confirmed_homeless').limit(1).maybeSingle();
      if (confirmedClaim) {
        enforcementExempt = true;
        exemptionReason = 'confirmed_homeless';
      }
    // No confirmed claim yet: a new claim will be raised by the officer
    // separately via the homeless-claims workflow (0191). The breach is
    // held as 'open' until an admin reviews and confirms/declines.
    }
    // Step 8a: At-risk detection (Tier 1 pilot requirement)
    let complianceStatus = 'unknown';
    // W1 fix: a zone-less scan or unconfigured zone is never a breach — benefit of the doubt.
    console.log(`[scan] plate=${plateNumber} compliant=${compliance.is_compliant} status=${complianceStatus} reason=${compliance.reason} exempt=${enforcementExempt}`);
    // Step 9: Write observation with the now-correct compliance verdict.
    const { data: obsData, error: obsErr } = await supabase.from('observations').insert({
      organization_id: orgId,
      officer_id: officerId,
      plate_number: plateNumber,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      zone_id: zoneId,
      site_id: siteId,
      location_id: locationId,
      observed_at: observedAt,
      plate_confidence: plateConfidence,
      plate_source: plateSource,
      vehicle_make: vehicleMake,
      vehicle_model: vehicleModel,
      vehicle_colour: vehicleColour,
      is_scv: isScv,
      scv_certificate_number: scvCertNumber,
      is_homeless: isHomeless,
      is_compliant: compliance.is_compliant,
      compliance_reason: compliance.reason,
      compliance_status: complianceStatus,
      enforcement_exempt: enforcementExempt,
      exemption_reason: exemptionReason,
      nights_this_zone: compliance.nights_this_zone,
      nights_this_month: compliance.nights_this_month,
      module_key: moduleKey,
      offline_queued: offlineQueued,
      synced_at: syncedAt ?? null,
      embedding: newEmbedding,
      embedding_quality: inferResult?.embedding_quality ?? null,
      detection_bbox: inferResult?.detection_bbox ?? null,
      detection_confidence: inferResult?.detection_confidence ?? null,
      sticker_presence: inferResult?.sticker_presence ?? null,
      sticker_color: inferResult?.sticker_color ?? null,
      sticker_detection_confidence: inferResult?.sticker_confidence ?? null,
      previous_observation_id: prevObs?.id ?? null,
      movement_moved: movementResult?.moved ?? null,
      movement_similarity: movementResult?.similarity ?? null,
      movement_decision: movementResult?.decision ?? null,
      client_org_id: clientOrgId ?? null
      ,geofence_context: geofenceContext
    }).select('id').single();
    if (obsErr || !obsData) return json({
      error: 'Failed to record observation',
      detail: obsErr?.message
    }, 500);
    const observationId = obsData.id;
    // Step 9b: Evidence photos
    const evidenceObservedAt = observedAt;
    const evidence = await attachScanEvidence(supabase, captureEvidence, {
      orgId,
      officerId,
      moduleKey,
      recordType: 'observation',
      recordId: observationId,
      clientRequestId
    });
    if (evidence.originalPath || evidence.watermarkedPath) {
      const { error: photoLinkError } = await supabase.from('observations').update({
        original_photo_url: evidence.originalPath,
        watermarked_photo_url: evidence.watermarkedPath,
        photo_url: evidence.watermarkedPath,
        photo_captured_at: evidenceObservedAt,
        photo_watermark_text: evidence.watermarkText
      }).eq('id', observationId);
      if (photoLinkError) throw new Error('The camping scan photo linkage was not confirmed.');
    }
    const sessionInput = {
      orgId, plateNumber, zoneId, siteId, locationId, observationId, observedAt, gpsLat, gpsLng,
      photoUrl: evidence.watermarkedPath, isScv, breachAlertId: null, movementResult, windowPeek, singleDailyPeek,
      prevObs: prevObs ? { id: prevObs.id, observed_at: prevObs.observed_at, photo_url: prevObs.original_photo_url } : null,
      complianceIsCompliant: null, complianceReason: 'pending', clientOrgId
    };
    const overnightSessionPre = verificationMode === 'single_daily_observation' && singleDailyPeek
      ? await upsertSingleDailyOvernightSession(supabase, sessionInput)
      : await upsertOvernightSession(supabase, sessionInput);
    const verificationStatusPre = overnightSessionPre.verification_status;
    if (zoneId) {
      const { data: complianceData, error: complianceErr } = await supabase.rpc('calculate_vehicle_compliance', { p_plate: plateNumber, p_zone_id: zoneId, p_org_id: orgId });
      if (complianceErr || !complianceData) throw new Error('The camping policy result was not confirmed.');
      compliance = complianceData;
    }
    if (!zoneId || compliance.reason === 'no_zone_configured' || compliance.reason === 'no_rules_configured') {
      complianceStatus = 'unknown';
    } else if (compliance.is_compliant === true) {
      const atRiskConsecutive = compliance.limit_consecutive !== null && compliance.nights_this_zone >= compliance.limit_consecutive - 1 && compliance.nights_this_zone < compliance.limit_consecutive;
      const atRiskMonthly = compliance.limit_monthly !== null && compliance.nights_this_month >= compliance.limit_monthly - 2 && compliance.nights_this_month < compliance.limit_monthly;
      complianceStatus = atRiskConsecutive || atRiskMonthly ? 'at_risk' : 'compliant';
    } else if (compliance.is_compliant === false) {
      complianceStatus = enforcementExempt ? 'breach_exempt' : 'breach';
    }
    const { error: verdictWriteError } = await supabase.from('observations').update({
      is_compliant: compliance.is_compliant, compliance_reason: compliance.reason, compliance_status: complianceStatus,
      nights_this_zone: compliance.nights_this_zone, nights_this_month: compliance.nights_this_month
    }).eq('id', observationId);
    if (verdictWriteError) throw new Error('The camping policy receipt could not be saved.');
    // Step 10: Breach alert -- GATED on verified_overnight.
    // An evening scan NEVER creates a breach_alerts row (#73 G1 fix at the
    // application layer; 0193 already fixes it at the DB layer).
    // A confirmed-homeless plate gets status='exempt_homeless' (0191) instead
    // of 'open', so it is excluded from the NTV/infringement queue.
    // BRANCHED on verificationMode:
    //   two_photo_verified       → morning scan + verified_overnight
    //   single_daily_observation → consecutive-day pair + verified_overnight
    let breachAlertId = null;
    let breachWriteError = null;
    const isMorningVerified = windowPeek.scanWindow === 'morning' && verificationStatusPre === 'verified_overnight';
    const isSingleDailyVerified = verificationMode === 'single_daily_observation' && verificationStatusPre === 'verified_overnight';
    if (!compliance.is_compliant && (isMorningVerified || isSingleDailyVerified)) {
      const breachType = compliance.reason === 'consecutive_night_limit_exceeded' ? 'nightly_limit' : compliance.reason === 'monthly_limit_exceeded' ? 'monthly_limit' : compliance.reason === 'no_scv_certificate' ? 'no_scv' : 'other';
      const breachStatus = enforcementExempt ? 'exempt_homeless' : 'open';
      // #162 fix: plain insert + unique-violation (23505) handling.
      // The partial unique index idx_breach_alerts_session_active_unique
      // cannot be inferred as an ON CONFLICT arbiter from a column list
      // alone (Postgres 42P10), so upsert always failed silently.
      const sessionId = overnightSessionPre.id ?? null;
      const { data: breachData, error: breachInsertErr } = await supabase.from('breach_alerts').insert({
        organization_id: orgId,
        observation_id: observationId,
        zone_id: zoneId,
        plate_number: plateNumber,
        breach_type: breachType,
        nights_count: compliance.nights_this_zone,
        limit_value: compliance.limit_consecutive ?? compliance.limit_monthly,
        status: breachStatus,
        overnight_session_id: sessionId,
        client_org_id: clientOrgId ?? null
      }).select('id').single();
      if (!breachInsertErr) {
        breachAlertId = breachData?.id;
      } else if (breachInsertErr.code === '23505') {
        // Duplicate: an active breach already exists for this session.
        // Select the existing row by the dedup key.
        if (sessionId) {
          const { data: existing } = await supabase.from('breach_alerts').select('id').eq('overnight_session_id', sessionId).in('status', [
            'open',
            'acknowledged',
            'actioned',
            'exempt_homeless'
          ]).maybeSingle();
          breachAlertId = existing?.id;
        }
      } else {
        // Unexpected error — log and surface in the response
        console.error('[scan] breach_alerts insert failed (FC Step 10):', breachInsertErr.code, breachInsertErr.message, breachInsertErr.details);
        breachWriteError = `FC breach insert failed: ${breachInsertErr.code} ${breachInsertErr.message}`;
      }
    }
    const overnightSession = overnightSessionPre;
    if (overnightSession.id) {
      const verified = overnightSession.verification_status === 'verified_overnight';
      const { error: sessionVerdictError } = await supabase.from('vehicle_overnight_sessions').update({
        is_compliant: verified ? compliance.is_compliant : null,
        compliance_reason: verified ? compliance.reason : overnightSession.verification_status,
        breach_alert_id: verified ? breachAlertId : null
      }).eq('id', overnightSession.id);
      if (sessionVerdictError) throw new Error('The overnight session verdict could not be saved.');
    }
    // Step 11: GPS log (non-blocking)
    if (gpsLat !== null && gpsLng !== null) {
      supabase.from('officer_gps_log').insert({
        organization_id: orgId,
        officer_id: officerId,
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        detected_zone_id: zoneId,
        activity_type: 'scan'
      }).then(()=>{});
    }
    // Step 12: Return verdict
    return completeReceipt({
      success: true,
      plate_number: plateNumber,
      plate_confidence: plateConfidence,
      alpr_used: alprUsed,
      alpr_provider: alprProvider,
      plate_source: plateSource,
      is_compliant: compliance.is_compliant,
      compliance_reason: compliance.reason,
      compliance_status: complianceStatus,
      nights_this_zone: compliance.nights_this_zone,
      nights_this_month: compliance.nights_this_month,
      limit_consecutive: compliance.limit_consecutive,
      limit_monthly: compliance.limit_monthly,
      scv_required: compliance.scv_required,
      is_scv: isScv,
      is_homeless: isHomeless,
      safety_warnings: safetyWarnings,
      zone_id: zoneId,
      zone_name: zoneName,
      // Geofence resolution context (advisory + on-site state from resolve_context).
      on_site: onSite,
      client_org_id: clientOrgId,
      in_operating_bounds: inOperatingBounds,
      out_of_bounds_district: outOfBoundsDistrict,
      effective_rules: effectiveRules,
      resolution_status: resolutionStatus,
      governor_overlap_flag: governorOverlapFlag,
      geofence_notice: geofenceNotice,
      zone_closed: zoneClosure?.closed === true,
      zone_closure: zoneClosure,
      vehicle_make: vehicleMake,
      vehicle_model: vehicleModel,
      vehicle_colour: vehicleColour,
      sticker_presence: inferResult?.sticker_presence ?? null,
      sticker_color: inferResult?.sticker_color ?? null,
      movement_moved: movementResult?.moved ?? null,
      movement_similarity: movementResult?.similarity ?? null,
      movement_decision: movementResult?.decision ?? null,
      detection_bbox: inferResult?.detection_bbox ?? null,
      observation_id: observationId,
      breach_alert_id: breachAlertId,
      original_photo_url: evidence.originalPath,
      watermarked_photo_url: evidence.watermarkedPath,
      verification_mode: verificationMode,
      overnight_session_id: overnightSession.id,
      overnight_date: overnightSession.overnight_date,
      scan_window: overnightSession.scan_window,
      overnight_verification_status: overnightSession.verification_status,
      requires_morning_verification: overnightSession.requires_morning_verification,
      duplicate_for_overnight_window: overnightSession.duplicate_for_window,
      overnight_observation_count: overnightSession.observation_count,
      ...breachWriteError ? {
        breach_write_error: breachWriteError
      } : {}
    });
  } catch (err) {
    console.error('[scan] unexpected error:', err);
    return json({ error: safeToRetry ? 'The scan could not be processed. Keep the saved photo and retry.' : 'The scan may be partially saved. Keep the photo and ask operations to recover this request.', code: safeToRetry ? 'scan_processing_failed' : 'scan_recovery_required' }, 500);
  }
});
