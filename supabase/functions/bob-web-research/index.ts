/**
 * bob-web-research — governed, human-invoked web research for Bob
 *
 * Compliance basis (old app governance carried forward):
 *   - No live web access unless a human explicitly invokes it in-session.
 *   - Trusted NZ/official sources first, then trusted technical docs.
 *   - Block risky source categories.
 *   - No private/local network targets (SSRF protection).
 *   - Redact PII before any external call.
 *   - Advisory only: never acts on fetched content; returns sources + confidence.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const WEB_SEARCH_API_URL = Deno.env.get('WEB_SEARCH_API_URL') ?? '';
const WEB_SEARCH_API_KEY = Deno.env.get('WEB_SEARCH_API_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_RESEARCH = new Set([
  'grand_master',
  'master',
  'admin'
]);
const MAX_FETCH = 6;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONTENT_CHARS = 6000;
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
  'ird.govt.nz',
  // National Library of NZ aggregator — indexes NZ Gazette notices (liquidations,
  // bankruptcies, land notices, secondary legislation) plus other government/
  // heritage collections. Third-party (not .govt.nz) but a reputable Crown
  // entity aggregator; scoped to corporate_adverse_notice_check + legal_research
  // auto-invoke purposes only — see bob-web-research AUTO_INVOKE_PURPOSES.
  'api.digitalnz.org',
  'digitalnz.org',
  'gazette.govt.nz'
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
async function fetchReadable(url) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FCM-Bob-Research/1.0'
      },
      redirect: 'follow'
    });
    clearTimeout(timer);
    if (!res.ok) return {
      url,
      error: `fetch_status_${res.status}`
    };
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 200) : url;
    const content = stripHtml(html).slice(0, MAX_CONTENT_CHARS);
    return {
      url,
      title,
      content,
      trust: trustScore(url)
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      url,
      error: e instanceof Error ? e.name : 'fetch_error'
    };
  }
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
    const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
    if (!profile || !CAN_RESEARCH.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    const AUTO_INVOKE_PURPOSES = new Set([
      'site_risk_corroboration',
      'corporate_profile_lookup',
      'corporate_adverse_notice_check',
      'legal_research'
    ]);
    const REQUIRED_SUBJECT_TYPE = {
      site_risk_corroboration: 'location',
      corporate_profile_lookup: 'corporate',
      corporate_adverse_notice_check: 'corporate',
      legal_research: 'legal_matter'
    };
    const CORPORATE_IDENTIFIED_PURPOSES = new Set([
      'corporate_profile_lookup',
      'corporate_adverse_notice_check'
    ]);
    const autoInvokePurpose = String(body.auto_invoke_purpose ?? '').trim();
    const isAutoInvoked = body.human_invoked !== true && AUTO_INVOKE_PURPOSES.has(autoInvokePurpose);
    if (body.human_invoked !== true && !isAutoInvoked) {
      return json({
        error: 'web_research_requires_human_invocation',
        message: 'Live web research must be explicitly invoked by a human in this session (set human_invoked=true), or fired for an allowlisted autonomous purpose (auto_invoke_purpose one of: ' + [
          ...AUTO_INVOKE_PURPOSES
        ].join(', ') + ') — trusted-domain sources only in that case.'
      }, 403);
    }
    // #97: HARD BOUNDARY — never auto-search a named individual's personal
    // criminal/investigation/disciplinary status (migration 0208). Previously
    // enforced only by prompt reasoning that could silently be out of context.
    // Now a code-level gate: require subject_type matching the declared purpose,
    // and for corporate purposes require a real corporate identifier so a
    // free-text personal-name search is structurally unavailable.
    if (isAutoInvoked) {
      const subjectType = String(body.subject_type ?? '').trim();
      const expected = REQUIRED_SUBJECT_TYPE[autoInvokePurpose];
      if (subjectType !== expected) {
        return json({
          error: 'subject_type_required',
          message: `Auto-invoked '${autoInvokePurpose}' requires subject_type='${expected}'. Never use auto-invoke to research a named individual's personal criminal/investigation/disciplinary status — hard boundary (0208).`
        }, 400);
      }
      if (CORPORATE_IDENTIFIED_PURPOSES.has(autoInvokePurpose)) {
        const companyName = String(body.company_name ?? '').trim();
        const nzbn = String(body.nzbn ?? '').trim();
        if (!companyName && !nzbn) {
          return json({
            error: 'corporate_identifier_required',
            message: `Auto-invoked '${autoInvokePurpose}' requires company_name or nzbn — resolve the corporate entity first, never a bare free-text query.`
          }, 400);
        }
      }
    }
    // Auto-invoked requests may not supply explicit urls — that would let a
    // caller point Bob at an arbitrary untrusted page under the cover of an
    // allowlisted purpose. Auto-invoke is query-driven against TRUSTED_DOMAINS
    // only.
    if (isAutoInvoked && Array.isArray(body.urls) && body.urls.length) {
      return json({
        error: 'auto_invoke_urls_not_allowed',
        message: 'Autonomous purpose-bound research cannot target explicit urls; it is restricted to a query against TRUSTED_DOMAINS.'
      }, 400);
    }
    const rawQuery = String(body.query ?? '').trim();
    if (!rawQuery && !(Array.isArray(body.urls) && body.urls.length)) {
      return json({
        error: 'Provide a query or explicit urls to research'
      }, 400);
    }
    if (rawQuery && isBlocked(rawQuery)) {
      return json({
        error: 'blocked_query_category'
      }, 422);
    }
    const query = redactPII(rawQuery);
    const maxResults = Math.min(Math.max(body.max_results ?? 5, 1), MAX_FETCH);
    let candidateUrls = [];
    if (Array.isArray(body.urls) && body.urls.length) {
      candidateUrls = body.urls.map((u)=>String(u).trim());
    } else if (WEB_SEARCH_API_URL && WEB_SEARCH_API_KEY) {
      try {
        const searchRes = await fetch(`${WEB_SEARCH_API_URL}?q=${encodeURIComponent(query)}&count=${maxResults * 2}`, {
          headers: {
            'Ocp-Apim-Subscription-Key': WEB_SEARCH_API_KEY,
            'X-Subscription-Token': WEB_SEARCH_API_KEY,
            'Accept': 'application/json'
          }
        });
        if (searchRes.ok) {
          const sdata = await searchRes.json();
          const items = sdata?.webPages?.value ?? sdata?.web?.results ?? sdata?.results ?? [];
          candidateUrls = items.map((i)=>i.url ?? i.link).filter(Boolean);
        }
      } catch (_e) {}
    } else {
      return json({
        error: 'no_search_provider',
        message: 'No search provider configured. Provide explicit urls, or set WEB_SEARCH_API_URL and WEB_SEARCH_API_KEY.'
      }, 422);
    }
    const filtered = [
      ...new Set(candidateUrls)
    ].filter((u)=>isSafePublicUrl(u) && !isBlocked(u))// Auto-invoked (no human in the loop this turn): ONLY the trusted-domain
    // allowlist qualifies (trustScore === 1). Never let an autonomous fire
    // fall back to a generic, lower-trust result.
    .filter((u)=>!isAutoInvoked || trustScore(u) === 1).sort((a, b)=>trustScore(b) - trustScore(a)).slice(0, maxResults);
    if (!filtered.length) {
      return json({
        success: true,
        query,
        sources: [],
        note: 'No safe, allowed sources resolved for this query.'
      });
    }
    const fetched = await Promise.all(filtered.map(fetchReadable));
    const sources = fetched.filter((f)=>'content' in f);
    const failures = fetched.filter((f)=>'error' in f);
    const overallConfidence = sources.length ? Math.round(sources.reduce((acc, s)=>acc + s.trust, 0) / sources.length * 100) / 100 : 0;
    return json({
      success: true,
      query,
      human_invoked: !isAutoInvoked,
      auto_invoke_purpose: isAutoInvoked ? autoInvokePurpose : null,
      confidence: overallConfidence,
      sources: sources.map((s)=>({
          url: s.url,
          title: s.title,
          trust: s.trust,
          excerpt: redactPII(s.content).slice(0, 1500)
        })),
      failed: failures,
      advisory: true,
      note: isAutoInvoked ? `Autonomous, purpose-bound research (${autoInvokePurpose}), trusted-domain sources only. Advisory only — Bob does not act on fetched content. A human must still confirm before this data is relied upon.` : 'Advisory research only. Bob does not act on fetched content. Verify against official sources before use.',
      audit: {
        actor_id: user.id,
        role: profile.role,
        redacted_query: query,
        auto_invoked: isAutoInvoked,
        purpose: autoInvokePurpose || null
      }
    });
  } catch (err) {
    console.error('[bob-web-research] error:', err);
    return json({
      error: 'Web research failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
