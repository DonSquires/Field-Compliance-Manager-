import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  inferAccessRecognition,
  type AccessRecognitionReceipt,
} from '../_shared/recognitionCandidates.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFERENCE_SERVICE_URL = (Deno.env.get('INFERENCE_SERVICE_URL') ?? '').replace(/\/+$/, '');
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const EVIDENCE_BUCKET = 'scans';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type RecognitionReceipt = AccessRecognitionReceipt | {
  status: 'not_requested' | 'unavailable';
  failure_reason?: string;
  provider?: string;
  model?: string;
  prompt_version?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: Uint8Array | Blob) {
  const payload = value instanceof Blob ? await value.arrayBuffer() : Uint8Array.from(value).buffer;
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function watermark(bytes: Uint8Array, text: string): Promise<Blob> {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) {
    throw new Error('Inference watermark service is not configured; photo evidence cannot be accepted');
  }
  const body = new FormData();
  body.append(
    'photo',
    new Blob([Uint8Array.from(bytes).buffer], { type: 'image/jpeg' }),
    'access_control_evidence.jpg',
  );
  body.append('watermark_text', text);
  const response = await fetch(`${INFERENCE_SERVICE_URL}/infer/watermark`, {
    method: 'POST',
    headers: { 'x-inference-api-key': INFERENCE_API_KEY },
    body,
  });
  if (!response.ok) {
    throw new Error(`Inference watermark service failed with HTTP ${response.status}`);
  }
  return response.blob();
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.replace('Bearer ', '').trim();
  const userSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const clientRequestId = String(body.client_request_id ?? '').trim();
    const eventKind = String(body.event_kind ?? '').trim();
    const subjectKind = String(body.subject_kind ?? '').trim();
    const officerDecision = String(body.officer_decision ?? '').trim();
    const decisionBasis = String(body.decision_basis ?? '').trim();
    const observedAt = body.observed_at ? new Date(body.observed_at).toISOString() : new Date().toISOString();
    const gpsLat = typeof body.gps_lat === 'number' ? body.gps_lat : null;
    const gpsLng = typeof body.gps_lng === 'number' ? body.gps_lng : null;
    const selectedSiteId = body.site_id ? String(body.site_id) : null;
    const selectedZoneId = body.zone_id ? String(body.zone_id) : null;

    if (!clientRequestId) return json({ error: 'client_request_id is required' }, 400);
    if (!['entry_request', 'exit', 'credential_check', 'visitor_arrival', 'door_security_check'].includes(eventKind)) {
      return json({ error: 'Unsupported access-control event kind' }, 400);
    }
    if (!['person', 'vehicle', 'mixed', 'unknown'].includes(subjectKind)) {
      return json({ error: 'Unsupported access-control subject kind' }, 400);
    }
    if (!['admitted', 'refused', 'escorted', 'departed', 'record_only'].includes(officerDecision)) {
      return json({ error: 'Unsupported officer decision' }, 400);
    }
    if (![
      'credential_present', 'known_person', 'visitor_authorization',
      'supervisor_authorization', 'safety_refusal', 'policy_refusal',
      'no_decision', 'other',
    ].includes(decisionBasis)) {
      return json({ error: 'Unsupported decision basis' }, 400);
    }
    if ((gpsLat === null) !== (gpsLng === null)) {
      return json({ error: 'Both GPS latitude and longitude are required together' }, 400);
    }

    const { data: profile, error: profileError } = await userSupabase
      .from('user_profiles')
      .select('id, organization_id')
      .eq('id', user.id)
      .single();
    if (profileError || !profile?.organization_id) {
      return json({ error: 'Active officer organization profile required' }, 403);
    }

    let geofenceContext: Record<string, unknown> = {
      resolution_status: gpsLat === null ? 'not_evaluated' : 'outside_all_geofences',
      on_site: false,
    };
    let siteId = selectedSiteId;
    let zoneId = selectedZoneId;

    if (gpsLat !== null && gpsLng !== null) {
      const { data: contextRows, error: contextError } = await userSupabase.rpc('resolve_context', {
        p_lat: gpsLat,
        p_lng: gpsLng,
        p_org_id: profile.organization_id,
        p_module_key: 'access_control',
        p_at: observedAt,
      });
      if (contextError) throw new Error(`Access-control place resolution failed: ${contextError.message}`);
      const context = Array.isArray(contextRows) ? contextRows[0] : contextRows;
      if (context) {
        geofenceContext = {
          resolution_status: context.resolution_status ?? 'outside_all_geofences',
          in_operating_bounds: Boolean(context.in_operating_bounds),
          on_site: Boolean(context.on_site),
          site_id: context.site_id ?? null,
          matched_zone_id: context.matched_zone_id ?? null,
          matched_module_key: context.matched_module_key ?? null,
          governing_jurisdiction_id: context.governing_jurisdiction_id ?? null,
          governor_overlap_flag: Boolean(context.governor_overlap_flag),
        };
        if (selectedSiteId && context.site_id && selectedSiteId !== context.site_id) {
          return json({ error: 'Selected site does not match the current verified place context' }, 409);
        }
        if (selectedZoneId && context.matched_zone_id && selectedZoneId !== context.matched_zone_id) {
          return json({ error: 'Selected zone does not match the current verified place context' }, 409);
        }
        siteId = selectedSiteId ?? context.site_id ?? null;
        zoneId = selectedZoneId ?? context.matched_zone_id ?? null;
      }
    }

    if (!siteId && !zoneId) {
      return json({
        error: 'No access-control place could be resolved. Select a site or move into a verified access-control zone.',
        geofence_context: geofenceContext,
      }, 409);
    }

    const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64.trim() : '';
    const evidence: Record<string, unknown>[] = [];
    let recognition: RecognitionReceipt = { status: 'not_requested' };
    let probeImageUrl: string | null = null;

    if (imageBase64) {
      const bytes = base64ToBytes(imageBase64);
      const watermarkText = [
        'Access control evidence',
        `Time ${observedAt}`,
        `Officer ${user.id}`,
        `Request ${clientRequestId}`,
        `Place ${zoneId ?? siteId}`,
      ].join(' | ');
      const basePath = `org/${profile.organization_id}/access-control/${clientRequestId}`;
      const originalPath = `${basePath}-original.jpg`;
      const watermarkedPath = `${basePath}-watermarked.jpg`;
      const watermarkedBlob = await watermark(bytes, watermarkText);
      const rawSha256 = await sha256Hex(bytes);
      const watermarkedSha256 = await sha256Hex(watermarkedBlob);

      const { error: originalError } = await serviceSupabase.storage
        .from(EVIDENCE_BUCKET)
        .upload(originalPath, new Blob([bytes], { type: 'image/jpeg' }), {
          upsert: true,
          contentType: 'image/jpeg',
        });
      if (originalError) throw originalError;

      const { error: watermarkedError } = await serviceSupabase.storage
        .from(EVIDENCE_BUCKET)
        .upload(watermarkedPath, watermarkedBlob, {
          upsert: true,
          contentType: 'image/jpeg',
        });
      if (watermarkedError) throw watermarkedError;

      evidence.push({
        original_path: originalPath,
        watermarked_path: watermarkedPath,
        captured_at: observedAt,
        evidence_kind: 'photo',
        raw_sha256: rawSha256,
        watermarked_sha256: watermarkedSha256,
        watermark_text: watermarkText,
        watermark_service: 'inference',
      });

      const { data: signed, error: signedError } = await serviceSupabase.storage
        .from(EVIDENCE_BUCKET)
        .createSignedUrl(watermarkedPath, 600);
      if (signedError || !signed?.signedUrl) {
        throw signedError ?? new Error('Private evidence URL could not be signed');
      }
      probeImageUrl = signed.signedUrl;

      try {
        recognition = await inferAccessRecognition({
          bytes,
          sourceSha256: rawSha256,
          organizationId: profile.organization_id,
          inferenceServiceUrl: INFERENCE_SERVICE_URL,
          inferenceApiKey: INFERENCE_API_KEY,
          serviceSupabase,
        });
      } catch (recognitionError) {
        console.error('Access-control deterministic recognition failed', recognitionError);
        recognition = {
          status: 'unavailable',
          failure_reason: recognitionError instanceof Error
            ? recognitionError.message
            : 'Deterministic recognition failed',
          provider: 'fcm-inference',
          model: 'yunet-sface-openvino-alpr-reid',
          prompt_version: 'access_recognition_v2',
        };
      }
    }

    const { data: receiptRows, error: receiptError } = await serviceSupabase.rpc(
      'submit_access_control_event_receipt',
      {
        p_actor_user_id: user.id,
        p_client_request_id: clientRequestId,
        p_observed_at: observedAt,
        p_site_id: siteId,
        p_zone_id: zoneId,
        p_shift_id: body.shift_id || null,
        p_event_kind: eventKind,
        p_subject_kind: subjectKind,
        p_officer_decision: officerDecision,
        p_decision_basis: decisionBasis,
        p_claimed_identity: String(body.claimed_identity ?? '').trim() || null,
        p_credential_reference: String(body.credential_reference ?? '').trim() || null,
        p_notes: String(body.notes ?? '').trim() || null,
        p_gps_lat: gpsLat,
        p_gps_lng: gpsLng,
        p_geofence_context: geofenceContext,
        p_evidence_items: evidence,
        p_recognition: recognition,
      },
    );
    if (receiptError) throw receiptError;
    const receipt = Array.isArray(receiptRows) ? receiptRows[0] : receiptRows;
    if (!receipt?.id) throw new Error('Access-control event receipt could not be confirmed');

    const { data: perception, error: perceptionError } = await serviceSupabase.rpc(
      'record_access_control_perception_envelope',
      { p_access_control_event_id: receipt.id },
    );
    if (perceptionError) {
      throw new Error(`Access-control perception receipt failed: ${perceptionError.message}`);
    }

    return json({
      success: true,
      event_id: receipt.id,
      created: receipt.created,
      received_at: receipt.received_at,
      evidence_state: receipt.evidence_state,
      recognition_review_state: receipt.recognition_review_state,
      geofence_status: receipt.geofence_status,
      officer_decision: officerDecision,
      recognition,
      probe_image_url: probeImageUrl,
      perception,
    });
  } catch (error) {
    console.error('Access-control event submission failed', error);
    return json({
      error: error instanceof Error ? error.message : 'Access-control event could not be submitted',
    }, 500);
  }
});
