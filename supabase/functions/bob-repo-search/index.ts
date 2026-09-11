/**
 * bob-repo-search — ADMIRAL-ONLY repository code read/search (Bob's grep)
 *                   + scoped append-only write to docs/bob/BOB_CHAT.md
 *
 * Lets the grand_master ask Bob to actually SEARCH and READ the codebase (e.g.
 * grep for from('locations') across apps/web, apps/api, supabase/functions) and
 * READ a file, instead of Bob merely explaining the command. Backed by the
 * GitLab API (read-only by nature — cannot write), NOT a server-side shell.
 *
 * The 'write_bob_chat' action is the SOLE write capability: it appends a
 * message to docs/bob/BOB_CHAT.md (Bob's private notepad) via the GitLab
 * Commits API. The target path is HARD-CODED — no other file can be written.
 *
 * DEFENCE IN DEPTH:
 *   1. Auth: JWT required; caller MUST be grand_master (admiral). No other rank.
 *   2. Read-only: uses GitLab blob search + raw file GET only (search/read).
 *   3. Write-scoped: write_bob_chat is hard-coded to docs/bob/BOB_CHAT.md only.
 *   4. Secret-safe: excludes .env*, key/secret/credential files, and redacts
 *      obvious secret-looking lines from returned file content.
 *
 * Env:
 *   GITLAB_READ_TOKEN   — project-scoped read_api/read_repository token
 *   GITLAB_WRITE_TOKEN  — separate write_repository token for write_bob_chat only
 *   GITLAB_PROJECT_ID   — numeric id or url-encoded path (default 83317421)
 *   GITLAB_ALLOWED_PROJECTS — exact comma-separated project IDs/paths allowed by this function
 *   GITLAB_BASE_URL     — default https://gitlab.com
 *   GITLAB_DEFAULT_REF  — default Main
 *
 * Body:
 *   { action: 'search', query: string, ref?: string, limit?: number }
 *   { action: 'read',   path: string,  ref?: string }
 *   { action: 'write_bob_chat', message: string }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';
import { BOB_CHAT_PATH as _BOB_CHAT_PATH, parseUnansweredEntries } from '../_shared/deterministic-logic.ts';
import { splitSearchTerms, detectCompoundQuery, deriveSearchStatus, deriveTermStatus, computeReadWindow, computeLineWindow, deriveReadProgress } from './search-logic.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Transitional compatibility: the existing secret is accepted for reads only.
// It must be replaced with GITLAB_READ_TOKEN after the scoped token is created.
const GITLAB_READ_TOKEN = Deno.env.get('GITLAB_READ_TOKEN') ?? Deno.env.get('GITLAB_TOKEN') ?? '';
const GITLAB_WRITE_TOKEN = Deno.env.get('GITLAB_WRITE_TOKEN') ?? '';
const GITLAB_PROJECT_ID = Deno.env.get('GITLAB_PROJECT_ID') ?? '83317421';
const GITLAB_ALLOWED_PROJECTS = new Set((Deno.env.get('GITLAB_ALLOWED_PROJECTS') ?? GITLAB_PROJECT_ID).split(',').map((value)=>value.trim()).filter(Boolean));
const GITLAB_BASE_URL = (Deno.env.get('GITLAB_BASE_URL') ?? 'https://gitlab.com').replace(/\/+$/, '');
const GITLAB_DEFAULT_REF = Deno.env.get('GITLAB_DEFAULT_REF') ?? 'Main';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_REPO = new Set([
  'grand_master'
]);
const SECRET_PATH = /(^|\/)(\.env|.*\.pem$|.*\.key$|.*secret.*|.*credential.*|id_rsa)/i;
// PRIVATE_PATH: files that are deliberately private from Bob's repo reader.
// docs/bob/JIMS_MEMORIES.md is the team-lead agent's own private memory; Bob
// must not read or surface it. (Bob has no other path to it: the knowledge
// corpus loader reads only knowledge_base/corpus/*.md, and the embed pipeline
// embeds only bob_knowledge_cards rows. Do NOT copy this file into either.)
// The team-lead agent reads it via its own tooling, not this function.
const PRIVATE_PATH = /(^|\/)JIMS_MEMORIES\.md$/i;
const SECRET_LINE = /((?:api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key)\s*[:=]\s*)(\S+)/i;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function redactSecretLines(text) {
  return text.split('\n').map((l)=>l.replace(SECRET_LINE, '$1[redacted]')).join('\n');
}
// Records the high-water line read for (conversation, path, ref) so an
// out-of-order or repeated read is detected instead of silently re-served.
// Best-effort/fail-open: a lookup or write failure never blocks the read.
async function trackReadProgress(admin, conversationId, path, ref, startLine, endLine, totalLines) {
  const empty = { previously_read_through: null, overlaps_prior_read: false, suggested_next_start_line: null, file_fully_read: false };
  const convId = String(conversationId ?? '').trim();
  if (!convId) return empty;
  try {
    const { data: existing } = await admin.from('bob_repo_read_progress').select('max_line_read').eq('conversation_id', convId).eq('path', path).eq('ref', ref).maybeSingle();
    const progress = deriveReadProgress(existing?.max_line_read ?? 0, startLine, endLine, totalLines);
    await admin.from('bob_repo_read_progress').upsert({
      conversation_id: convId,
      path,
      ref,
      max_line_read: progress.max_line_read,
      last_start_line: startLine,
      last_end_line: endLine,
      updated_at: new Date().toISOString()
    }, { onConflict: 'conversation_id,path,ref' });
    return progress;
  } catch (e) {
    console.warn('[bob-repo-search] trackReadProgress failed (non-fatal):', e);
    return empty;
  }
}
async function gl(path, token = GITLAB_READ_TOKEN) {
  return fetch(`${GITLAB_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}${path}`, {
    headers: {
      'PRIVATE-TOKEN': token
    }
  });
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
    const effectiveRole = resolveEffectiveRole(user.email, String(profile?.role ?? 'guest'));
    if (!CAN_REPO.has(effectiveRole)) {
      return json({
        error: 'Forbidden: admiral (grand_master) only'
      }, 403);
    }
    if (!GITLAB_ALLOWED_PROJECTS.has(GITLAB_PROJECT_ID)) return json({
      error: 'Repo search project is not allowlisted'
    }, 503);
    const body = await req.json().catch(()=>({}));
    const action = String(body.action ?? 'search');
    if (!GITLAB_READ_TOKEN) return json({
      error: 'Repo search not configured (GITLAB_READ_TOKEN or legacy GITLAB_TOKEN missing)'
    }, 503);
    const ref = String(body.ref ?? GITLAB_DEFAULT_REF);
    if (action === 'search') {
      const query = String(body.query ?? '').trim();
      if (!query) return json({
        error: 'query is required'
      }, 400);
      const limit = Math.min(Math.max(Number(body.limit ?? 30), 1), 100);
      // #327: detect compound multi-instruction input BEFORE searching.
      // A compound query (semicolons, multiple newlines, multiple quoted strings,
      // or excessive length) passed as a single literal term produces a false
      // not_found — the #327 failure mode. Reject with an actionable message
      // rather than silently returning not_found (0).
      const compoundReason = detectCompoundQuery(query);
      if (compoundReason) {
        return json({
          ok: false,
          action,
          query,
          status: 'malformed_query',
          error: compoundReason,
          hint: 'Use action="search" with a single term, or use | to OR multiple terms (e.g. "BoundaryVerificationConfirm|process-officer-scan"). Use action="read" with a path for file reads.',
          terms_searched: [],
          term_status: [],
          count: 0,
          results: []
        }, 422);
      }
      // MULTI-TERM / OR handling (Bob criterion 3). GitLab BASIC blob search has
      // NO boolean/OR support, so a `a|b|c` query is otherwise treated as one
      // literal token and returns a false zero. Split on `|`, search each term,
      // aggregate + dedupe. Single-term queries take the same path (one term).
      const terms = splitSearchTerms(query);
      const wasOrQuery = terms.length > 1;
      const seen = new Set();
      const results = [];
      let couldNotVerify = false; // any term whose search call errored
      const failedTerms = [];
      // PER-TERM STATUS MAP (Bob #2 / Jim #5): each term carries its OWN outcome
      // so a clean-zero term and an errored term are distinguishable per-question,
      // not collapsed into one aggregate. status: found | not_found | could_not_verify.
      const termStatus = [];
      for (const term of terms){
        const r = await gl(`/search?scope=blobs&ref=${encodeURIComponent(ref)}&search=${encodeURIComponent(term)}&per_page=${limit}`);
        if (!r.ok) {
          // A term we COULD NOT SEARCH is not evidence of absence (Bob criterion
          // 1/5): record it as could_not_verify, never fold it into not_found.
          // Include only upstream status and opaque request ID, never credentials
          // or a response body, so operators can distinguish auth, project, ref,
          // and GitLab service failures without exposing protected information.
          const failure = {
            status: r.status,
            request_id: r.headers.get('x-request-id') ?? r.headers.get('x-gitlab-request-id') ?? null
          };
          couldNotVerify = true;
          failedTerms.push(`${term} (GitLab HTTP ${failure.status}${failure.request_id ? `; request ${failure.request_id}` : ''})`);
          termStatus.push({
            term,
            status: deriveTermStatus({
              failed: true,
              hitCount: 0
            }),
            count: 0,
            failure
          });
          continue;
        }
        const hits = await r.json().catch(()=>[]);
        let termHits = 0;
        for (const h of hits){
          const p = String(h.path ?? '');
          if (SECRET_PATH.test(p) || PRIVATE_PATH.test(p)) continue;
          termHits++; // this term matched (counted pre-cap so the map is truthful about coverage)
          const dedupeKey = `${p}#${h.startline ?? ''}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          // TOTAL-LIMIT CAP (Jim #3): the aggregate result list never exceeds the
          // caller's `limit`, even across N terms. Per-term `count` still reflects
          // what the term matched, so capping never hides a term's real coverage.
          if (results.length < limit) {
            results.push({
              path: h.path,
              startline: h.startline,
              snippet: redactSecretLines(String(h.data ?? '')).slice(0, 500)
            });
          }
        }
        termStatus.push({
          term,
          status: deriveTermStatus({
            failed: false,
            hitCount: termHits
          }),
          count: termHits
        });
      }
      // DISTINGUISHED EMPTY (Bob criteria 1 + 5): the AGGREGATE status still tells
      // absence from could-not-see; the per-term map above tells it per question.
      const { status, note } = deriveSearchStatus({
        resultCount: results.length,
        couldNotVerify,
        failedTerms,
        wasOrQuery,
        termCount: terms.length
      });
      return json({
        ok: true,
        action,
        query,
        ref,
        status,
        note,
        terms_searched: terms,
        term_status: termStatus,
        count: results.length,
        capped: results.length >= limit,
        results
      });
    }
    if (action === 'read') {
      const path = String(body.path ?? '').trim();
      if (!path) return json({
        error: 'path is required'
      }, 400);
      if (SECRET_PATH.test(path)) return json({
        ok: false,
        error: 'That path is excluded (secrets are not readable).'
      }, 403);
      if (PRIVATE_PATH.test(path)) return json({
        ok: false,
        error: 'That path is private and not readable.'
      }, 403);
      const r = await gl(`/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`);
      if (r.status === 404) return json({
        ok: false,
        error: `File not found: ${path} @ ${ref}`
      }, 404);
      if (!r.ok) return json({
        ok: false,
        error: `GitLab file read returned ${r.status}`
      }, 502);
      const raw = await r.text();
      // Redact BEFORE windowing so a redaction can never be split across a window
      // boundary (a half-redacted secret line would defeat the guard). The window
      // math is the pure computeReadWindow helper (Bob Blocker 1, boundary-tested).
      const redacted = redactSecretLines(raw);
      if (body.start_line !== undefined || body.end_line !== undefined) {
        const lineWindow = computeLineWindow(redacted, Number(body.start_line), Number(body.end_line));
        const progress = await trackReadProgress(admin, body.conversation_id, path, ref, lineWindow.startLine, lineWindow.endLine, lineWindow.totalLines);
        return json({
          ok: true,
          action,
          path,
          ref,
          read_state: lineWindow.readState,
          total_lines: lineWindow.totalLines,
          start_line: lineWindow.startLine,
          end_line: lineWindow.endLine,
          requested_end_line: lineWindow.requestedEndLine,
          has_more: lineWindow.hasMore,
          next_start_line: lineWindow.nextStartLine,
          truncated: lineWindow.hasMore,
          content: lineWindow.content,
          already_read_through: progress.previously_read_through,
          overlaps_prior_read: progress.overlaps_prior_read,
          suggested_next_start_line: progress.overlaps_prior_read ? progress.suggested_next_start_line : null,
          file_fully_read: progress.file_fully_read
        });
      }
      const rawOffset = Number(body.offset ?? 0);
      const w = computeReadWindow(redacted, rawOffset);
      return json({
        ok: true,
        action,
        path,
        ref,
        read_state: w.readState,
        read_note: w.readNote,
        total_length: w.totalLength,
        offset: w.offset,
        returned: w.returned,
        has_more: w.hasMore,
        next_offset: w.nextOffset,
        truncated: w.hasMore,
        content: w.content
      });
    }
    // ── WRITE_BOB_CHAT — append-only write to Bob's private notepad ─────────
    // HARD-CODED to docs/bob/BOB_CHAT.md. No path parameter accepted.
    // Fetches current content, appends the new message, commits via GitLab API.
    if (action === 'write_bob_chat') {
      if (!GITLAB_WRITE_TOKEN) return json({
        error: 'Repo write not configured'
      }, 503);
      const BOB_CHAT_PATH = _BOB_CHAT_PATH; // hard-coded constant from shared module
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return json({
        error: 'message is required (non-empty string)'
      }, 400);
      if (message.length > 20000) return json({
        error: 'message too long (max 20000 chars)'
      }, 400);
      // 1. Fetch current file content
      const fileRef = GITLAB_DEFAULT_REF;
      const rawRes = await gl(`/repository/files/${encodeURIComponent(BOB_CHAT_PATH)}/raw?ref=${encodeURIComponent(fileRef)}`);
      if (!rawRes.ok && rawRes.status !== 404) {
        return json({
          ok: false,
          error: `GitLab file read returned ${rawRes.status}`
        }, 502);
      }
      const existingContent = rawRes.ok ? await rawRes.text() : '';
      // 2. Build the appended block
      const timestamp = new Date().toISOString();
      const appendBlock = `\n\n---\n\n**Bob** — ${timestamp}\n\n${message}\n`;
      const newContent = existingContent + appendBlock;
      // 3. Commit via the GitLab Commits API (single 'update' or 'create' action)
      const commitAction = rawRes.ok ? 'update' : 'create';
      const commitRes = await fetch(`${GITLAB_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}/repository/commits`, {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': GITLAB_WRITE_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          branch: fileRef,
          commit_message: 'Bob: note in BOB_CHAT.md',
          actions: [
            {
              action: commitAction,
              file_path: BOB_CHAT_PATH,
              content: newContent
            }
          ]
        })
      });
      if (!commitRes.ok) {
        const errText = await commitRes.text().catch(()=>'');
        console.error(`[bob-repo-search] write_bob_chat commit failed: ${commitRes.status} ${errText.slice(0, 300)}`);
        return json({
          ok: false,
          error: `GitLab commit returned ${commitRes.status}`
        }, 502);
      }
      const commitData = await commitRes.json().catch(()=>({}));
      return json({
        ok: true,
        action: 'write_bob_chat',
        path: BOB_CHAT_PATH,
        commit_id: commitData.short_id ?? commitData.id ?? null
      });
    }
    // ── READ_BOB_CHAT — pageable full-file read + unanswered-entry scan ────
    // HARD-CODED to docs/bob/BOB_CHAT.md. Reads a PAGEABLE WINDOW over the
    // FULL file (via computeReadWindow, same helper as the `read` action) and
    // extracts entries tagged status:unanswered from the full content.
    //
    // Before #317 this returned only the last BOB_CHAT_TAIL_SIZE (8000) chars
    // as tail_content, making content older than the tail unreachable. Now the
    // caller can pass `offset` to page through the entire file. The field name
    // `tail_content` is kept for back-compat with the conductor.
    //
    // Returns:
    //   { ok, action, path, unanswered_entries: [...], tail_content,
    //     total_length, has_more, next_offset, offset, returned }
    //
    // unanswered_entries: parsed entries with { header, author, date, body }
    // tail_content: the windowed content at the requested offset
    if (action === 'read_bob_chat') {
      const BOB_CHAT_PATH = _BOB_CHAT_PATH; // hard-coded constant from shared module
      const fileRef = GITLAB_DEFAULT_REF;
      const r = await gl(`/repository/files/${encodeURIComponent(BOB_CHAT_PATH)}/raw?ref=${encodeURIComponent(fileRef)}`);
      if (r.status === 404) return json({
        ok: false,
        error: `File not found: ${BOB_CHAT_PATH} @ ${fileRef}`
      }, 404);
      if (!r.ok) return json({
        ok: false,
        error: `GitLab file read returned ${r.status}`,
        status: 'could_not_verify'
      }, 502);
      const raw = await r.text();
      const totalLength = raw.length;
      // Extract unanswered entries: scan the FULL file content (not the window).
      // parseUnansweredEntries is the shared pure helper — same function the
      // tests exercise. Returns entries in file order (last = newest).
      const unansweredEntries = parseUnansweredEntries(raw);
      // Pageable window over the FULL file (#317). Uses the same
      // computeReadWindow helper as the `read` action — already imported,
      // already boundary-tested. The caller passes `offset` to page; default
      // 0 returns the first window (oldest content). The conductor's
      // renderNotepadTail handles newest-anchored rendering from whatever
      // window the tool returns.
      // Default to the NEWEST end of the file (where new messages land).
      // Explicit offset pages backward into older content (#317 full-file paging).
      // Window size matches computeReadWindow default (20000 chars).
      const WINDOW_SIZE = 20000;
      const defaultOffset = Math.max(0, raw.length - WINDOW_SIZE);
      const rawOffset = body.offset !== undefined ? Number(body.offset) : defaultOffset;
      const w = computeReadWindow(raw, rawOffset);
      return json({
        ok: true,
        action: 'read_bob_chat',
        path: BOB_CHAT_PATH,
        ref: fileRef,
        total_length: totalLength,
        has_more: w.hasMore,
        next_offset: w.nextOffset,
        offset: w.offset,
        returned: w.returned,
        unanswered_count: unansweredEntries.length,
        unanswered_entries: unansweredEntries,
        tail_content: w.content
      });
    }
    return json({
      error: `Unknown action '${action}'`,
      valid: [
        'search',
        'read',
        'write_bob_chat',
        'read_bob_chat'
      ]
    }, 422);
  } catch (err) {
    console.error('[bob-repo-search] error:', err);
    return json({
      ok: false,
      error: 'Repo search failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
