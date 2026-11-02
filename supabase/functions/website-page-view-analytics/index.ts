// ATLAS EXTERNAL CALLER: randmsecurity-website-vercel-api
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PAGE_PATH = /^\/(about|contact|gallery|privacy|services(\/[a-z0-9-]+)?|blog(\/[a-z0-9-]+)?)?$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const REGION_CODE = /^[A-Z0-9-]{1,15}$/;
const NOTICE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_BODY_BYTES = 1024;

let serviceClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Supabase service credentials are not configured');
  serviceClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}

function jsonResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  const configuredSecret = Deno.env.get('WEBSITE_ANALYTICS_SHARED_SECRET');
  if (!configuredSecret) return jsonResponse(503, 'analytics_unavailable');
  if (request.headers.get('x-website-analytics-secret') !== configuredSecret) {
    return jsonResponse(401, 'unauthorized');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return jsonResponse(415, 'json_required');
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413, 'request_too_large');
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, 'request_too_large');
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse(400, 'invalid_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(400, 'invalid_request');
  }

  const values = body as Record<string, unknown>;
  const pagePath = typeof values.page_path === 'string' ? values.page_path.trim() : '';
  const noticeVersion = typeof values.notice_version === 'string' ? values.notice_version : '';
  const countryInput = typeof values.country_code === 'string' ? values.country_code.trim().toUpperCase() : '';
  const regionInput = typeof values.region_code === 'string' ? values.region_code.trim().toUpperCase() : '';
  if (pagePath.length > 160 || !PAGE_PATH.test(pagePath)) return jsonResponse(400, 'invalid_page_path');
  if (!NOTICE_VERSION.test(noticeVersion)) return jsonResponse(400, 'invalid_notice_version');
  const countryCode = COUNTRY_CODE.test(countryInput) ? countryInput : 'ZZ';
  const regionCode = countryCode === 'ZZ' || !REGION_CODE.test(regionInput) ? 'ZZ' : regionInput;

  try {
    const { error } = await getServiceClient().rpc('record_website_page_view', {
      p_page_path: pagePath,
      p_country_code: countryCode,
      p_region_code: regionCode,
      p_notice_version: noticeVersion,
    });
    if (error?.message.includes('website_analytics_not_enabled')) {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    if (error) {
      console.error('website analytics recording failed', { code: error.code ?? 'unknown' });
      return jsonResponse(503, 'analytics_unavailable');
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('website analytics recording failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return jsonResponse(503, 'analytics_unavailable');
  }
});
