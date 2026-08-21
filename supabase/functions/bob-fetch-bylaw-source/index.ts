/**
 * bob-fetch-bylaw-source — governed, human-invoked URL ingestion for a
 * council's Freedom Camping bylaw (or infringement/NTV notice template).
 *
 * Distinct from bob-web-research (advisory-only search/research, never acts
 * on fetched content): this function's output feeds the governed
 * propose -> approve pipeline. It fetches ONE explicit URL (no search-
 * provider fan-out — a bylaw is a named source a council gives Bob, not a
 * search query), stores the readable text as a .txt blob in the EXISTING
 * bob-uploads bucket via the EXISTING bob_attachments contract (0012), and
 * marks the row source_type='url' + source_url (0192) so the SAME
 * extraction step a file upload goes through (extractFreedomCampingBylaw,
 * apps/api) can read it identically.
 *
 * Safety model reused verbatim from bob-web-research (do not diverge):
 *   - isSafePublicUrl: SSRF protection (no localhost/private-range targets).
 *   - BLOCKED_PATTERNS: risky content-category screen.
 *   - redactPII: strip emails/phones before any text is persisted.
 *   - trustScore: TRUSTED_DOMAINS (legislation.govt.nz, govt.nz, etc.) score
 *     higher than an arbitrary third-party mirror — low-trust sources force
 *     manual_review_required=true downstream regardless of extraction
 *     confidence, since an unofficial bylaw mirror could be stale or altered.
 *
 * Auth: Supabase JWT required. Caller must be admin/master/grand_master
 * (same CAN_PROPOSE tier as every propose_* producer) AND must explicitly
 * invoke this (human_invoked:true), mirroring bob-web-research's gate —
 * Bob never fetches an external URL on its own initiative.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_FETCH = new Set([
  'grand_master',
  'master',
  'admin'
]);
const FETCH_TIMEOUT_MS = 15_000; // bylaw pages/PDF-hosting pages can be slower than a search result
const MAX_CONTENT_CHARS = 60_000; // bylaws are long; allow more than bob-web-research's 6000 excerpt cap
const MAX_STORED_BYTES = 10 * 1024 * 1024; // matches bob-uploads bucket file_size_limit (0012)
// Reused verbatim from bob-web-research (keep in sync if that list changes).
const TRUSTED_DOMAINS = [
  'legislation.govt.nz',
  'govt.nz',
  'linz.govt.nz',
  'stats.govt.nz',
  'nzta.govt.nz',
  'privacy.org.nz',
  'worksafe.govt.nz',
  'justice.govt.nz',
  'police.govt.nz',
  'standards.govt.nz',
  'business.govt.nz',
  'ird.govt.nz'
];
const BLOCKED_PATTERNS = [
  /porn|adult|xxx|escort/i,
  /casino|gambling|betting|poker/i,
  /malware|phishing|warez|crack|keygen/i
];
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function redactPII(text) {
  return String(text ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]').replace(/\b(\+?64|0)2\d(?:[ -]?\d){6,8}\b/g, '[redacted-phone]');
}
function isBlocked(value) {
  return BLOCKED_PATTERNS.some((p)=>p.test(value));
}
function isSafePublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch  {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
  if (/^\d+$/.test(host)) return false;
  return true;
}
function trustScore(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TRUSTED_DOMAINS.some((d)=>host === d || host.endsWith(`.${d}`)) ? 1 : 0.4;
  } catch  {
    return 0;
  }
}
function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_FETCH.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    if (body.human_invoked !== true) {
      return json({
        error: 'fetch_requires_human_invocation',
        message: 'Fetching an external bylaw source must be explicitly invoked by a human in this session. Set human_invoked=true to proceed.'
      }, 403);
    }
    const rawUrl = String(body.url ?? '').trim();
    if (!rawUrl) return json({
      error: 'url is required'
    }, 400);
    if (!isSafePublicUrl(rawUrl)) return json({
      error: 'url is not a safe public http(s) address'
    }, 422);
    if (isBlocked(rawUrl)) return json({
      error: 'blocked_url_category'
    }, 422);
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), FETCH_TIMEOUT_MS);
    let html;
    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'FCM-Bob-BylawIngest/1.0'
        },
        redirect: 'follow'
      });
      clearTimeout(timer);
      if (!res.ok) return json({
        error: `fetch_status_${res.status}`
      }, 422);
      html = await res.text();
    } catch (e) {
      clearTimeout(timer);
      return json({
        error: 'fetch_failed',
        detail: e instanceof Error ? e.name : 'fetch_error'
      }, 502);
    }
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 200) : rawUrl;
    const text = redactPII(stripHtml(html)).slice(0, MAX_CONTENT_CHARS);
    const trust = trustScore(rawUrl);
    if (!text.trim()) {
      return json({
        error: 'no_readable_text',
        message: 'Could not extract readable text from this URL. If it links directly to a PDF, download it and upload the file instead.',
        trust
      }, 422);
    }
    // Persist as a .txt blob through the SAME storage contract a file upload
    // uses (0012: bucket 'bob-uploads', path convention org/{org}/bob/{conv}/{id}-{name}),
    // so extraction reads it identically regardless of source_type.
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_STORED_BYTES) {
      return json({
        error: 'content_too_large',
        message: 'Fetched text exceeds the 10 MB Bob attachment limit.'
      }, 422);
    }
    const orgId = String(profile.organization_id ?? '');
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id.trim() ? body.conversation_id.trim() : null;
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'external-source';
    const fileId = crypto.randomUUID();
    const safeFileName = `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    const storagePath = conversationId ? `org/${orgId}/bob/${conversationId}/${fileId}-${safeFileName}` : `org/${orgId}/bob/url-fetch/${fileId}-${safeFileName}`;
    const { error: uploadErr } = await admin.storage.from('bob-uploads').upload(storagePath, bytes, {
      upsert: true,
      contentType: 'text/plain'
    });
    if (uploadErr) return json({
      error: 'storage_upload_failed',
      detail: uploadErr.message
    }, 500);
    // conversation_id is NOT NULL on bob_attachments (0012); if the caller has
    // no conversation yet, refuse cleanly rather than write an invalid row —
    // the chat flow always has one by the time a fetch is invoked.
    if (!conversationId) {
      return json({
        error: 'conversation_id is required to record this attachment'
      }, 400);
    }
    const { data: attachment, error: insErr } = await admin.from('bob_attachments').insert({
      organization_id: orgId,
      conversation_id: conversationId,
      uploaded_by: user.id,
      file_name: safeFileName,
      file_type: 'text/plain',
      file_size_bytes: bytes.byteLength,
      storage_bucket: 'bob-uploads',
      storage_path: storagePath,
      purpose: 'document_intake',
      processing_state: 'pending',
      source_type: 'url',
      source_url: rawUrl
    }).select('id').single();
    if (insErr || !attachment) {
      return json({
        error: 'Could not record the fetched source',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      attachment_id: attachment.id,
      title,
      trust,
      low_trust: trust < 1,
      chars_fetched: text.length,
      note: trust < 1 ? `Fetched '${title}' from ${rawUrl}. This is NOT a .govt.nz source — extraction will be flagged for mandatory manual review regardless of confidence.` : `Fetched '${title}' from ${rawUrl}. Ready for extraction (attachment_id ${attachment.id}).`
    });
  } catch (err) {
    console.error('[bob-fetch-bylaw-source] error:', err);
    return json({
      error: 'Bylaw source fetch failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
