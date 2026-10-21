/**
 * bob-repo-search — ADMIRAL-ONLY repository code read/search (Bob's grep)
 *                   + append-only Builder notes in Supabase
 *
 * Lets the grand_master ask Bob to actually SEARCH and READ the codebase and
 * READ a file, instead of Bob merely explaining the command.
 *
 * TARGET REPOSITORY (owner ruling, single target build): `search` and `read`
 * answer from the Bob control plane's own checkout of the repository being built
 * (GET /api/bob/builder/repository/{search,file,head,tree}), pinned to main.
 * The notepad aliases store Builder notes in bob_self_memory, not a repository.
 *
 * DEFENCE IN DEPTH:
 *   1. Auth: JWT required; caller MUST be grand_master (admiral). No other rank.
 *   2. Read-only: search/file GETs on the control plane; no shell.
 *   3. Write-scoped: write_bob_chat appends builder_note entries only.
 *   4. Secret-safe: excludes .env*, key/secret/credential files (here and on the
 *      control plane), and redacts obvious secret-looking lines from content.
 *
 * Env:
 *   BOB_CONTROL_PLANE_URL / BOB_ADMIN_TOKEN — the control plane (search/read)
 *
 * Body:
 *   { action: 'search', query: string, path?: string, limit?: number }
 *   { action: 'read',   path: string, start_line?, end_line? | offset? }
 *   { action: 'write_bob_chat', message: string }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';
import { BOB_CHAT_PATH as _BOB_CHAT_PATH, parseUnansweredEntries } from '../_shared/deterministic-logic.ts';
import { splitSearchTerms, detectCompoundQuery, deriveSearchStatus, deriveTermStatus, computeReadWindow, computeLineWindow, deriveReadProgress, pathLikeTerm } from './search-logic.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CONTROL_PLANE_URL = (Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '').replace(/\/+$/, '');
const CONTROL_PLANE_TOKEN = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN') ?? '';
const REPO_REF = 'main';
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
  const empty = {
    previously_read_through: null,
    overlaps_prior_read: false,
    suggested_next_start_line: null,
    file_fully_read: false
  };
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
    }, {
      onConflict: 'conversation_id,path,ref'
    });
    return progress;
  } catch (e) {
    console.warn('[bob-repo-search] trackReadProgress failed (non-fatal):', e);
    return empty;
  }
}
// The build's own repository, served by the control plane from its pinned checkout.
async function cp(path) {
  return fetch(`${CONTROL_PLANE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${CONTROL_PLANE_TOKEN}`
    },
    signal: AbortSignal.timeout(45_000)
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
    const body = await req.json().catch(()=>({}));
    const action = String(body.action ?? 'search');
    if (['search', 'read', 'head', 'tree'].includes(action) && (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN)) return json({
      error: 'Repo search not configured (BOB_CONTROL_PLANE_URL / BOB_ADMIN_TOKEN missing)'
    }, 503);
    const ref = REPO_REF;
    if (action === 'head' || action === 'tree') {
      const path = String(body.path ?? '').replace(/^\/+/, '');
      if (SECRET_PATH.test(path) || PRIVATE_PATH.test(path)) return json({ error: 'That path is excluded.' }, 403);
      const response = await cp(`/api/bob/builder/repository/${action}?${new URLSearchParams({ ref, path })}`);
      if (!response.ok) return json({ ok: false, error: `Repository ${action} returned ${response.status}` }, 502);
      return json({ ...(await response.json()), action });
    }
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
      // Split OR queries and retain per-term evidence instead of hiding failed reads.
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
      const pathspec = typeof body.path === 'string' && body.path.trim() ? `&path=${encodeURIComponent(body.path.trim())}` : '';
      for (const term of terms){
        const r = await cp(`/api/bob/builder/repository/search?q=${encodeURIComponent(term)}&limit=${limit}${pathspec}`).catch(()=>null);
        if (!r || !r.ok) {
          // A term we COULD NOT SEARCH is not evidence of absence (Bob criterion
          // 1/5): record it as could_not_verify, never fold it into not_found.
          const failure = {
            status: r ? r.status : 0
          };
          couldNotVerify = true;
          failedTerms.push(`${term} (repository HTTP ${failure.status || 'unreachable'})`);
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
        const payload = await r.json().catch(()=>({}));
        const hits = Array.isArray(payload.matches) ? payload.matches : [];
        let termHits = Number(payload.count) || hits.length;
        for (const h of hits){
          const p = String(h.path ?? '');
          if (SECRET_PATH.test(p) || PRIVATE_PATH.test(p)) {
            termHits = Math.max(0, termHits - 1);
            continue;
          }
          const dedupeKey = `${p}#${h.line ?? ''}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          // TOTAL-LIMIT CAP (Jim #3): the aggregate result list never exceeds the
          // caller's `limit`, even across N terms. Per-term `count` still reflects
          // what the term matched, so capping never hides a term's real coverage.
          if (results.length < limit) {
            results.push({
              path: h.path,
              startline: h.line,
              snippet: redactSecretLines(String(h.text ?? '')).slice(0, 500)
            });
          }
        }
        let pathExists = false;
        const asPath = termHits === 0 ? pathLikeTerm(term) : null;
        if (asPath && !SECRET_PATH.test(asPath.path) && !PRIVATE_PATH.test(asPath.path)) {
          const tree = await cp(`/api/bob/builder/repository/tree?${new URLSearchParams({ path: asPath.dir })}`).catch(()=>null);
          const listing = tree && tree.ok ? await tree.json().catch(()=>null) : null;
          pathExists = Array.isArray(listing?.entries) && listing.entries.includes(asPath.base);
          if (pathExists) {
            termHits = 1;
            if (!seen.has(`${asPath.path}#`) && results.length < limit) {
              seen.add(`${asPath.path}#`);
              results.push({ path: asPath.path, startline: null, snippet: 'file exists at this path (path match; content search is text-only)' });
            }
          }
        }
        termStatus.push({
          term,
          status: deriveTermStatus({
            failed: false,
            hitCount: termHits
          }),
          count: termHits,
          ...(pathExists ? { match: 'path' } : {})
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
      const r = await cp(`/api/bob/builder/repository/file?path=${encodeURIComponent(path)}`).catch(()=>null);
      if (r && r.status === 404) return json({
        ok: false,
        error: `File not found: ${path} @ ${ref}`
      }, 404);
      if (r && r.status === 403) return json({
        ok: false,
        error: 'That path is excluded (secrets and binaries are not readable).'
      }, 403);
      if (!r || !r.ok) return json({
        ok: false,
        error: `Repository file read returned ${r ? r.status : 'unreachable'}`
      }, 502);
      const raw = String((await r.json().catch(()=>({}))).content ?? '');
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
    if (action === 'write_bob_chat') {
      const BOB_CHAT_PATH = _BOB_CHAT_PATH;
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return json({
        error: 'message is required (non-empty string)'
      }, 400);
      if (message.length > 20000) return json({
        error: 'message too long (max 20000 chars)'
      }, 400);
      // ATLAS WRITES: bob_self_memory
      const { data: note, error } = await admin.from('bob_self_memory').insert({
        memory_text: message, memory_kind: 'builder_note', status: 'kept',
        proposed_by: '00000000-0000-0000-0000-00000000b0b0',
      }).select('id').single();
      if (error) throw error;
      return json({
        ok: true,
        action: 'write_bob_chat',
        path: BOB_CHAT_PATH,
        commit_id: null,
        memory_id: note.id,
        storage: 'supabase'
      });
    }
    if (action === 'read_bob_chat') {
      const BOB_CHAT_PATH = _BOB_CHAT_PATH;
      const noteOffset = Number(body.note_offset ?? 0);
      if (!Number.isSafeInteger(noteOffset) || noteOffset < 0) return json({ error: 'note_offset must be a non-negative integer' }, 400);
      // ATLAS READS: bob_self_memory
      const query = admin.from('bob_self_memory').select('id,memory_text,created_at')
        .eq('memory_kind', 'builder_note').eq('status', 'kept')
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(noteOffset, noteOffset + 100);
      const { data: notes, error } = await query;
      if (error) throw error;
      const moreNotes = notes.length > 100;
      const page = notes.slice(0, 100);
      const raw = redactSecretLines([...page].reverse().map(note => `\n\n---\n\n**Bob** — ${note.created_at}\n\n${note.memory_text}\n`).join(''));
      const totalLength = raw.length;
      const unansweredEntries = parseUnansweredEntries(raw);
      const WINDOW_SIZE = 20000;
      const defaultOffset = Math.max(0, raw.length - WINDOW_SIZE);
      const rawOffset = body.offset !== undefined ? Number(body.offset) : defaultOffset;
      const w = computeReadWindow(raw, rawOffset);
      return json({
        ok: true,
        action: 'read_bob_chat',
        path: BOB_CHAT_PATH,
        ref: 'supabase',
        storage: 'supabase',
        has_older_notes: moreNotes,
        next_note_offset: moreNotes ? noteOffset + 100 : null,
        note_offset: noteOffset,
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
        'head',
        'tree',
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
