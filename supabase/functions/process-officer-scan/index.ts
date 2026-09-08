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
    const plate = rawPlate ? rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
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
    const decision = data.confidence === 'different' ? 'moved' : data.confidence === 'same' ? 'stationary' : 'inconclusive';
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
      await supabase.from('vehicle_overnight_sessions').update({
        evening_observation_id: input.observationId,
        evening_seen_at: input.observedAt,
        evening_gps_lat: input.gpsLat,
        evening_gps_lng: input.gpsLng,
        evening_photo_url: input.photoUrl,
        observation_count: count,
        updated_at: new Date().toISOString()
      }).eq('id', existingSessionId);
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
    const { data: created } = await supabase.from('vehicle_overnight_sessions').insert({
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
  await supabase.from('vehicle_overnight_sessions').update({
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
    await supabase.from('vehicle_overnight_sessions').update({
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
  const { data: created } = await supabase.from('vehicle_overnight_sessions').insert({
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
    evening_photo_url: null,
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
    body: formData
  });
  if (!res.ok) {
    throw new Error(`Inference watermark service failed with HTTP ${res.status}`);
  }
  return await res.blob();
}
async function storeScanEvidence(supabase, input) {
  if (!input.imageBase64) return {
    originalPath: null,
    watermarkedPath: null,
    watermarkText: null
  };
  const bytes = base64ToBytes(input.imageBase64);
  const basePath = `org/${input.orgId}/observations/${input.observationId}`;
  // #315 Part 1: timestamped, collision-resistant paths — never overwrite
  // evidence. Mirrors the append-only pattern in EvidencePhotoUpload.tsx.
  const ts = Date.now();
  const originalPath = `${basePath}/${ts}-original.jpg`;
  const watermarkedPath = `${basePath}/${ts}-watermarked.jpg`;
  const watermarkText = [
    `Plate ${input.plateNumber}`,
    `Time ${input.observedAt}`,
    input.zoneName ? `Zone ${input.zoneName}` : null,
    input.gpsLat !== null && input.gpsLng !== null ? `GPS ${input.gpsLat.toFixed(6)}, ${input.gpsLng.toFixed(6)}` : 'GPS unavailable',
    `Officer ${input.officerId}`,
    `Observation ${input.observationId}`
  ].filter(Boolean).join(' | ');
  const watermarked = await renderWatermarkedEvidence(bytes, watermarkText);
  const rawSha256 = await sha256Hex(bytes);
  const watermarkedSha256 = await sha256Hex(watermarked);
  await supabase.storage.from(SCAN_BUCKET).upload(originalPath, new Blob([
    bytes
  ], {
    type: 'image/jpeg'
  }), {
    upsert: false,
    contentType: 'image/jpeg'
  });
  await supabase.storage.from(SCAN_BUCKET).upload(watermarkedPath, watermarked, {
    upsert: false,
    contentType: 'image/jpeg'
  });
  const { error: evidenceError } = await supabase.rpc('register_edge_court_photo', {
    p_organization_id: input.orgId,
    p_module_key: input.moduleKey,
    p_storage_path: watermarkedPath,
    p_captured_at: input.observedAt,
    p_metadata: { original_path: originalPath, raw_sha256: rawSha256, watermarked_sha256: watermarkedSha256, watermark_text: watermarkText, watermark_service: 'inference', observation_id: input.observationId }
  });
  if (evidenceError) throw evidenceError;
  return {
    originalPath,
    watermarkedPath,
    watermarkText,
    rawSha256,
    watermarkedSha256
  };
}
// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  try {
    // Step 1: Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const { data: profile } = await supabase.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile?.organization_id) return json({
      error: 'Officer profile not found or not linked to an organisation'
    }, 403);
    const orgId = profile.organization_id;
    const officerId = profile.id;
    // Step 2: Parse input
    const body = await req.json();
    const { image_base64: imageBase64, gps_lat: gpsLat, gps_lng: gpsLng, zone_id: manualZoneId, module_key: moduleKey = 'freedom_camping', captured_at: capturedAt, offline_queued: offlineQueued = false, synced_at: syncedAt } = body;
    if (!['freedom_camping', 'parking_enforcement'].includes(moduleKey)) return json({
      error: 'Unsupported scan module'
    }, 400);
    if (!imageBase64) return json({
      error: 'Photo evidence is required for this scan. Capture a clear vehicle image for ALPR.'
    }, 400);
    const hasLatitude = gpsLat !== null && gpsLat !== undefined;
    const hasLongitude = gpsLng !== null && gpsLng !== undefined;
    if (!manualZoneId && (!hasLatitude || !hasLongitude)) return json({
      error: 'A manual Zone or complete GPS coordinates are required'
    }, 400);
    if (hasLatitude !== hasLongitude || hasLatitude && (!Number.isFinite(Number(gpsLat)) || !Number.isFinite(Number(gpsLng)) || Number(gpsLat) < -90 || Number(gpsLat) > 90 || Number(gpsLng) < -180 || Number(gpsLng) > 180)) return json({
      error: 'gps_lat and gps_lng must be a complete valid coordinate pair'
    }, 400);
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
    // Steps 3 & 4: ALPR + full inference in parallel (same photo, two calls)
    let alprResult = null;
    let inferResult = null;
    let alprUsed = false;
    if (imageBase64) {
      [alprResult, inferResult] = await Promise.all([
        runAlpr(imageBase64),
        runInference(imageBase64)
      ]);
      if (!alprResult?.plate || alprResult.confidence < MIN_ALPR_CONFIDENCE) {
        const fallbackResult = await runPlateRecognizerAlpr(imageBase64);
        if (fallbackResult?.plate && fallbackResult.confidence >= MIN_ALPR_CONFIDENCE) {
          alprResult = fallbackResult;
        }
      }
      alprUsed = alprResult !== null;
    }
    const plateNumber = (alprResult?.plate ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!plateNumber) return json({
      error: 'A plate could not be confirmed from the photo. Capture a clearer image and try again.'
    }, 400);
    const plateConfidence = alprResult?.confidence ?? null;
    const plateSource = 'alpr';
    const alprProvider = alprResult?.provider ?? null;
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
    let onSite = false;
    let inOperatingBounds = true;
    let outOfBoundsDistrict = null;
    let effectiveRules = null;
    let zoneClosure = null;
    if (!zoneId && hasLatitude && hasLongitude) {
      const { data: ctxRows, error: contextError } = await supabase.rpc('resolve_operational_context', {
        p_lat: Number(gpsLat),
        p_lng: Number(gpsLng),
        p_org_id: orgId,
        p_module_key: moduleKey ?? null
      });
      if (contextError) return json({
        error: 'Geofence context could not be resolved',
        detail: contextError.message
      }, 503);
      const ctx = Array.isArray(ctxRows) ? ctxRows[0] : ctxRows;
      if (ctx) {
        zoneId = ctx.matched_zone_id ?? null;
        siteId = ctx.site_id ?? null;
        clientOrgId = ctx.client_org_id ?? null;
        onSite = ctx.on_site === true;
        inOperatingBounds = ctx.in_operating_bounds !== false;
        outOfBoundsDistrict = ctx.out_of_bounds_district ?? null;
        effectiveRules = ctx.effective_rules ?? null;
      }
      console.log(`[scan] resolve_operational_context zone=${zoneId ?? 'none'} on_site=${onSite} in_bounds=${inOperatingBounds}`);
    }
    if (zoneId) {
      // Lightweight fetch for the zone name (used in the evidence watermark) and
      // location_id; site_id already came from resolve_context.
      let zoneQuery = supabase.from('location_zones').select('id, name, location_id, site_id, module_key, active_schedule, boundary_verification').eq('id', zoneId).eq('is_active', true);
      if (manualZoneId) zoneQuery = zoneQuery.eq('organization_id', orgId);
      const { data: zoneData, error: zoneError } = await zoneQuery.maybeSingle();
      if (zoneError) return json({ error: 'Zone context could not be loaded', detail: zoneError.message }, 503);
      if (!zoneData || zoneData.boundary_verification !== 'verified') return json({ error: 'An active verified Zone in this organization is required' }, 409);
      if (moduleKey && zoneData.module_key && zoneData.module_key !== moduleKey) return json({ error: 'Selected Zone does not support this scan module' }, 409);
      if (manualZoneId) {
        const { data: scheduleActive, error: scheduleError } = await supabase.rpc('_geofence_active_at', { p_schedule: zoneData.active_schedule, p_at: capturedDate.toISOString() });
        if (scheduleError) return json({ error: 'Zone schedule could not be resolved', detail: scheduleError.message }, 503);
        if (scheduleActive !== true) return json({ error: 'Selected Zone is not active at the capture time' }, 409);
      }
      zoneName = zoneData.name;
      locationId = zoneData.location_id;
      if (!siteId) siteId = zoneData.site_id;
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
      resolution_source: manualZoneId ? 'manual_zone' : 'resolve_operational_context',
      spatial_resolution_evaluated: !manualZoneId && hasLatitude && hasLongitude,
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
        supabase.from('parking_chalk_records').select('id, chalked_at, return_by, status, embedding, photo_url, zone_id').eq('organization_id', orgId).eq('plate', plateNumber).eq('status', 'active').order('chalked_at', {
          ascending: false
        }).limit(1).maybeSingle(),
        // c. Zone parking rules from location_zones
        zoneId ? supabase.from('location_zones').select('parking_time_limit_minutes, parking_disabled_multiplier').eq('id', zoneId).single() : Promise.resolve({
          data: null
        }),
        // d. parking_module_config for org defaults
        supabase.from('parking_module_config').select('default_time_limit_minutes, grace_period_minutes').eq('organization_id', orgId).maybeSingle(),
        // e. Officer display name for chalk record
        supabase.from('user_profiles').select('display_name').eq('id', officerId).single()
      ]);
      const parkingVehicle = parkingVehicleRes.data;
      const priorChalk = parkingChalkRes.data;
      const parkingOfficerName = parkingOfficerRes.data?.display_name ?? null;
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
        await supabase.from('parking_chalk_records').update({
          status: 'compliant',
          resolved_at: new Date().toISOString()
        }).eq('id', priorChalk.id);
        console.log(`[scan:parking] prior chalk ${priorChalk.id} marked compliant (vehicle moved)`);
      }
      let parkingCompliance = {
        verdict: 'clear',
        effective_limit_minutes: 60,
        grace_period_minutes: 5,
        chalked_at: null,
        minutes_elapsed: null,
        is_overstay: false,
        is_repeat: false,
        repeat_count: 0,
        recommended_action: 'none'
      };
      // Only run compliance if vehicle did NOT move (moved = compliant, no need to check)
      if (!parkingMovement?.moved) {
        const { data: compData, error: compErr } = await supabase.rpc('evaluate_parking_compliance', {
          p_org_id: orgId,
          p_zone_id: zoneId,
          p_plate: plateNumber,
          p_is_disabled_bay: parkingScene?.is_disabled_bay ?? false,
          p_sign_time_limit_minutes: parkingScene?.sign_time_limit_minutes ?? null
        });
        if (!compErr && compData) {
          parkingCompliance = compData;
        }
      }
      console.log(`[scan:parking] compliance: verdict=${parkingCompliance.verdict} overstay=${parkingCompliance.is_overstay} repeat=${parkingCompliance.is_repeat}`);
      // Step 9P: Write parking_chalk_records
      const effectiveLimitMinutes = parkingCompliance.effective_limit_minutes;
      const effectiveLimitMs = effectiveLimitMinutes * 60 * 1000;
      // C5 fix: use a single timestamp for both chalked_at and return_by
      // to avoid drift between separate Date.now() calls.
      const parkingNowMs = Date.now();
      const parkingObservedAt = new Date(parkingNowMs).toISOString();
      const { data: chalkData, error: chalkErr } = await supabase.from('parking_chalk_records').insert({
        organization_id: orgId,
        plate: plateNumber,
        zone_id: zoneId,
        client_site_id: siteId,
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
      const parkingEvidence = await storeScanEvidence(supabase, {
        orgId,
        observationId: chalkRecordId,
        imageBase64,
        plateNumber,
        officerId,
        moduleKey: 'parking_enforcement',
        observedAt: parkingObservedAt,
        gpsLat,
        gpsLng,
        zoneName
      });
      if (parkingEvidence.originalPath || parkingEvidence.watermarkedPath) {
        await supabase.from('parking_chalk_records').update({
          photo_url: parkingEvidence.watermarkedPath ?? parkingEvidence.originalPath
        }).eq('id', chalkRecordId);
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
      for (const flag of vehicleComplianceFlags){
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
      return json({
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
        // Geofence context
        zone_id: zoneId,
        zone_name: zoneName,
        on_site: onSite,
        in_operating_bounds: inOperatingBounds,
        out_of_bounds_district: outOfBoundsDistrict,
        effective_rules: effectiveRules,
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
      supabase.from('canonical_vehicles').select('make, model, year, colour').eq('plate_number', plateNumber).maybeSingle(),
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
    // Step 7b: Write the overnight session row NOW (before compliance check)
    // so the RPC counts this morning's verified overnight correctly.
    // BRANCHED on verificationMode:
    //   two_photo_verified       → upsertOvernightSession (evening/morning window)
    //   single_daily_observation → upsertSingleDailyOvernightSession (calendar-day pair)
    // breachAlertId is null here; it gets stamped back onto the session row
    // after Step 10 creates the breach_alerts row.
    let overnightSessionPre;
    let singleDailySessionId = null;
    if (verificationMode === 'single_daily_observation' && singleDailyPeek) {
      overnightSessionPre = await upsertSingleDailyOvernightSession(supabase, {
        orgId,
        plateNumber,
        zoneId,
        siteId,
        locationId,
        observationId: '',
        observedAt,
        gpsLat,
        gpsLng,
        photoUrl: null,
        isScv,
        breachAlertId: null,
        movementResult,
        singleDailyPeek,
        prevObs: prevObs ? {
          id: prevObs.id,
          observed_at: prevObs.observed_at
        } : null,
        complianceIsCompliant: true,
        complianceReason: 'pending',
        clientOrgId
      });
      // Thread the REAL session id from the pre-compliance write so the
      // post-compliance call (Step 10b) always performs a genuine UPDATE.
      singleDailySessionId = overnightSessionPre.id;
    } else {
      overnightSessionPre = await upsertOvernightSession(supabase, {
        orgId,
        plateNumber,
        zoneId,
        siteId,
        locationId,
        observationId: '',
        observedAt,
        gpsLat,
        gpsLng,
        photoUrl: null,
        isScv,
        breachAlertId: null,
        movementResult,
        windowPeek,
        complianceIsCompliant: true,
        complianceReason: 'pending',
        clientOrgId
      });
    }
    const verificationStatusPre = overnightSessionPre.verification_status;
    console.log(`[scan] session_pre id=${overnightSessionPre.id ?? 'none'} status=${verificationStatusPre ?? 'none'}`);
    // Step 8: Compliance check -- now runs AFTER the session row exists, so
    // calculate_vehicle_compliance (0193) correctly counts this morning's
    // verified overnight when deciding the verdict.
    let compliance = {
      is_compliant: true,
      reason: 'no_zone_configured',
      nights_this_zone: 0,
      nights_this_month: 0,
      limit_consecutive: null,
      limit_monthly: null,
      scv_required: false,
      is_scv: isScv
    };
    if (zoneId) {
      const { data: complianceData, error: complianceErr } = await supabase.rpc('calculate_vehicle_compliance', {
        p_plate: plateNumber,
        p_zone_id: zoneId,
        p_org_id: orgId
      });
      if (!complianceErr && complianceData) compliance = complianceData;
    }
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
    // SCV sticker override: blue sticker = physical evidence of SCV certification
    const stickerBlue = inferResult?.sticker_presence === true && inferResult?.sticker_color === 'blue';
    if (stickerBlue && compliance.reason === 'no_scv_certificate') {
      compliance.is_compliant = true;
      compliance.reason = 'scv_sticker_detected';
    }
    // Step 8a: At-risk detection (Tier 1 pilot requirement)
    let complianceStatus = 'unknown';
    // W1 fix: a zone-less scan or unconfigured zone is never a breach — benefit of the doubt.
    if (!zoneId || compliance.reason === 'no_zone_configured' || compliance.reason === 'no_rules_configured') {
      complianceStatus = 'unknown';
    } else if (compliance.is_compliant) {
      const atRiskConsecutive = compliance.limit_consecutive !== null && compliance.nights_this_zone >= compliance.limit_consecutive - 1 && compliance.nights_this_zone < compliance.limit_consecutive;
      const atRiskMonthly = compliance.limit_monthly !== null && compliance.nights_this_month >= compliance.limit_monthly - 2 && compliance.nights_this_month < compliance.limit_monthly;
      complianceStatus = atRiskConsecutive || atRiskMonthly ? 'at_risk' : 'compliant';
    } else if (enforcementExempt) {
      complianceStatus = 'breach_exempt'; // non-compliant but enforcement suppressed
    } else {
      complianceStatus = 'breach';
    }
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
    const evidence = await storeScanEvidence(supabase, {
      orgId,
      observationId,
      imageBase64,
      plateNumber,
      officerId,
      moduleKey,
      observedAt: evidenceObservedAt,
      gpsLat,
      gpsLng,
      zoneName
    });
    if (evidence.originalPath || evidence.watermarkedPath) {
      await supabase.from('observations').update({
        original_photo_url: evidence.originalPath,
        watermarked_photo_url: evidence.watermarkedPath,
        photo_url: evidence.watermarkedPath,
        photo_captured_at: evidenceObservedAt,
        photo_watermark_text: evidence.watermarkText
      }).eq('id', observationId);
    }
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
    // Step 10b: Stamp the real observation_id, photo_url, compliance verdict,
    // and breach_alert_id back onto the session row now that we have them.
    // (The pre-compliance upsert used placeholder values.)
    // BRANCHED on verificationMode:
    //   two_photo_verified       → upsertOvernightSession (same as Step 7b)
    //   single_daily_observation → upsertSingleDailyOvernightSession, threading
    //     the REAL session id from the pre-compliance write so the second call
    //     always performs a genuine UPDATE (not a fragile insert-that-silently-fails).
    let overnightSession;
    if (verificationMode === 'single_daily_observation' && singleDailyPeek) {
      // Thread the real session id into the peek so the write function finds
      // the existing row and UPDATEs it instead of attempting a duplicate INSERT.
      const peekWithRealId = {
        ...singleDailyPeek,
        existingSessionId: singleDailySessionId
      };
      overnightSession = await upsertSingleDailyOvernightSession(supabase, {
        orgId,
        plateNumber,
        zoneId,
        siteId,
        locationId,
        observationId,
        observedAt,
        gpsLat,
        gpsLng,
        photoUrl: evidence.watermarkedPath,
        isScv,
        breachAlertId,
        movementResult,
        singleDailyPeek: peekWithRealId,
        prevObs: prevObs ? {
          id: prevObs.id,
          observed_at: prevObs.observed_at
        } : null,
        complianceIsCompliant: compliance.is_compliant,
        complianceReason: compliance.reason,
        clientOrgId
      });
    } else {
      overnightSession = await upsertOvernightSession(supabase, {
        orgId,
        plateNumber,
        zoneId,
        siteId,
        locationId,
        observationId,
        observedAt,
        gpsLat,
        gpsLng,
        photoUrl: evidence.watermarkedPath,
        isScv,
        breachAlertId,
        movementResult,
        windowPeek,
        complianceIsCompliant: compliance.is_compliant,
        complianceReason: compliance.reason,
        clientOrgId
      });
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
    return json({
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
      zone_id: zoneId,
      zone_name: zoneName,
      // Geofence resolution context (advisory + on-site state from resolve_context).
      on_site: onSite,
      client_org_id: clientOrgId,
      in_operating_bounds: inOperatingBounds,
      out_of_bounds_district: outOfBoundsDistrict,
      effective_rules: effectiveRules,
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
    return new Response(JSON.stringify({
      error: 'Scan pipeline encountered an unexpected error.',
      detail: err instanceof Error ? err.message : String(err)
    }), {
      status: 500,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
});
