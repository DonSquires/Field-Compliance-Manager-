import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  credentialFreeCarjamSourceUrl,
  normalizePlate,
  parseCarjamBasicResponse,
} from '../_shared/carjamVehicle.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CARJAM_API_KEY = Deno.env.get('CARJAM_API_KEY') ?? '';
const CARJAM_STORAGE_AUTHORIZATION_REFERENCE =
  Deno.env.get('CARJAM_STORAGE_AUTHORIZATION_REFERENCE') ?? '';

const CARJAM_API_URL = 'https://www.carjam.co.nz/api/car/';
const CARJAM_SOURCE_LOCATION =
  'CarJam Developer Connection API — New Zealand Motor Vehicle Register';
const CARJAM_TERMS_URL =
  'https://www.carjam.co.nz/cms:page?t=api-terms-and-conditions';
const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function authorize(authHeader: string) {
  if (
    !SUPABASE_SERVICE_ROLE_KEY ||
    authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  ) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Vehicle enrichment is not configured.' }, 503);
    }
    if (!CARJAM_API_KEY) {
      return json({ error: 'CarJam Developer Connection API key is not configured.' }, 503);
    }
    if (CARJAM_STORAGE_AUTHORIZATION_REFERENCE.trim().length < 3) {
      return json(
        {
          error:
            'CarJam written authorization for automated storage has not been recorded.',
        },
        503,
      );
    }

    authorize(req.headers.get('Authorization') ?? '');

    const body = await req.json().catch(() => ({}));
    const plate = normalizePlate(body.plate);
    const canonicalVehicleId = String(body.canonical_vehicle_id ?? '').trim();
    const clientRequestId = String(body.client_request_id ?? '').trim();
    if (!/^[A-Z0-9]{1,10}$/.test(plate)) {
      return json({ error: 'valid plate is required' }, 400);
    }
    if (canonicalVehicleId && !UUID_PATTERN.test(canonicalVehicleId)) {
      return json({ error: 'canonical_vehicle_id must be a UUID' }, 400);
    }
    if (!UUID_PATTERN.test(clientRequestId)) {
      return json({ error: 'client_request_id must be a UUID' }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let vehicleQuery = admin
      .from('canonical_vehicles')
      .select('id, plate_number')
      .eq('plate_number', plate);
    if (canonicalVehicleId) vehicleQuery = vehicleQuery.eq('id', canonicalVehicleId);
    const { data: canonicalVehicle, error: vehicleError } =
      await vehicleQuery.maybeSingle();
    if (vehicleError) throw vehicleError;
    if (!canonicalVehicle) {
      return json(
        { error: 'Canonical vehicle not found. CarJam cannot create vehicle identities.' },
        404,
      );
    }

    const providerUrl = new URL(CARJAM_API_URL);
    providerUrl.searchParams.set('key', CARJAM_API_KEY);
    providerUrl.searchParams.set('plate', plate);
    providerUrl.searchParams.set('basic', '1');
    providerUrl.searchParams.set('f', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(providerUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Field-Compliance-Manager/1.0',
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return json(
        {
          error: 'carjam_lookup_failed',
          status: response.status,
          retry_after: response.headers.get('retry-after'),
        },
        response.status === 429 ? 429 : 502,
      );
    }

    const rawResponse = await response.text();
    if (new TextEncoder().encode(rawResponse).byteLength > MAX_RESPONSE_BYTES) {
      return json({ error: 'carjam_response_too_large' }, 502);
    }

    let providerPayload: unknown;
    try {
      providerPayload = JSON.parse(rawResponse);
    } catch {
      return json({ error: 'carjam_invalid_json' }, 502);
    }

    let extracted;
    try {
      extracted = parseCarjamBasicResponse(providerPayload, plate);
    } catch (error) {
      return json(
        {
          error: 'carjam_vehicle_data_unavailable',
          details: error instanceof Error ? error.message : 'Unsupported response',
        },
        422,
      );
    }

    const sourceUrl = credentialFreeCarjamSourceUrl(CARJAM_API_URL, plate);
    const retrievedAt = new Date().toISOString();
    const responseSha256 = await sha256(rawResponse);
    const { data: receipt, error: receiptError } = await admin.rpc(
      'record_carjam_vehicle_enrichment',
      {
        p_client_request_id: clientRequestId,
        p_canonical_vehicle_id: canonicalVehicle.id,
        p_plate: plate,
        p_make: extracted.make,
        p_model: extracted.model,
        p_year: extracted.year,
        p_colour: extracted.colour,
        p_body_type: extracted.body_type,
        p_fuel_type: extracted.fuel_type,
        p_source_url: sourceUrl,
        p_source_location: CARJAM_SOURCE_LOCATION,
        p_source_terms_url: CARJAM_TERMS_URL,
        p_storage_authorization_reference:
          CARJAM_STORAGE_AUTHORIZATION_REFERENCE,
        p_response_sha256: responseSha256,
        p_retrieved_at: retrievedAt,
      },
    );
    if (receiptError) throw receiptError;

    return json({
      ok: true,
      plate,
      canonical_vehicle_id: canonicalVehicle.id,
      vehicle: extracted,
      source: {
        name: 'CarJam Developer Connection API',
        url: sourceUrl,
        location: CARJAM_SOURCE_LOCATION,
        terms_url: CARJAM_TERMS_URL,
        retrieved_at: retrievedAt,
      },
      receipt,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return json({ error: 'carjam_lookup_timeout' }, 504);
    }
    console.error('carjam-vehicle-lookup failed', error);
    return json({ error: 'carjam_lookup_error' }, 500);
  }
});
