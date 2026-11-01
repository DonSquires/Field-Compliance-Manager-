/**
 * bob-plan-import — agentic import planner (READ-ONLY)
 *
 * The single agentic entry point for the universal importer. Given a parsed
 * document (or raw text), Bob:
 *   1. parses rows (quoted CSV, delimiter sniff, junk section-header skip),
 *   2. recalls any learned mapping for this document shape (bob-import-memory),
 *   3. infers CANDIDATE target tables from the LIVE schema (bob_inspect_schema
 *      with no args = every public table) scored against the row's headers —
 *      NO hardcoded table list,
 *   4. runs bob-map-import against each candidate (value-validation + the >=3
 *      validated-column confidence gate),
 *   5. returns a governed multi-step PLAN (ready-to-run bob-job-runner job JSON,
 *      all steps dry_run) plus the proposed mapping to show the user.
 *
 * It writes NOTHING. Governance stays in the conductor / bob-job-runner
 * (approval + app_surface gates) and execution in bob-upsert-generic
 * (schema-driven, with the write-only sensitive floor). This function only
 * READS — including sensitive tables — so Bob can reason freely.
 *
 * Auth: service-role/cron OR a JWT admin/master/grand_master (mirrors the other
 * bob read functions). Being read-only, it never mutates anything.
 *
 * Body:
 *   {
 *     "document_text": "csv text...",   // or:
 *     "rows": [ { ... }, ... ],
 *     "headers": [...], "sample_rows": [[...]],
 *     "file_name": "patrol.csv",
 *     "target_tables": ["client_sites"],  // optional override; else inferred
 *     "max_candidates": 4,
 *     "sample_size": 25,
 *     "organization_id": "uuid"
 *   }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
// Bob's reasoning brain (model-driven target/column mapping). Reached via the
// bob-inference proxy so API_URL/API_TOKEN stay server-side. Optional: if these
// are unset or the call fails, bob-plan-import falls back to the deterministic
// scorer below, so the importer is never left dead.
const BOB_INFERENCE_URL = Deno.env.get('BOB_INFERENCE_URL') ?? '';
const BOB_INFERENCE_SECRET = Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
const CAN_PLAN = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const DEFAULT_MAX_CANDIDATES = 4;
const DEFAULT_SAMPLE_SIZE = 25;
// Canonical synonym table — kept IDENTICAL to bob-map-import and
// bob-upsert-generic so mapping/scoring is consistent end-to-end. Direction is
// ALIAS -> CANONICAL COLUMN (e.g. a 'company' header maps to the 'name' column).
const SYNONYMS = {
  phone_number: 'phone',
  mobile_number: 'mobile',
  email_address: 'email',
  company: 'name',
  company_name: 'name',
  client: 'client_name',
  org_id: 'organization_id',
  street: 'address',
  street_address: 'address',
  amount: 'total_amount',
  total: 'total_amount',
  due_at: 'due_date',
  issued_at: 'invoice_date'
};
// Sensitive tables Bob may READ but must never be PLANNED as a write target.
// Mirrors bob-upsert-generic's floor (auth/identity/governance/audit). Bob can
// still read them elsewhere for reasoning; they just cannot be import targets.
const NON_TARGET_TABLES = new Set([
  'bob_job_runs',
  'bob_job_rollback_refs',
  'bob_agentic_actions',
  'bob_knowledge_cards',
  'bob_context_memory',
  'bob_learning_memory',
  'bob_messages',
  'bob_conversations',
  'bob_attachments',
  'user_profiles',
  'provider_client_access_grants',
  'staff_branch_authorisations',
  'audit_log',
  'user_management_audit',
  'key_audit_settings',
  'officer_gps_log'
]);
const NON_TARGET_PREFIXES = [
  'pg_',
  'auth_',
  '_seed_',
  'schema_migrations',
  'spatial_ref_sys',
  '_migration'
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
function normKey(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function isTargetable(table) {
  if (NON_TARGET_TABLES.has(table)) return false;
  return !NON_TARGET_PREFIXES.some((p)=>table.startsWith(p));
}
// Ask Bob's model brain (via the bob-inference proxy) to choose the target table
// and column mapping by REASONING over the headers, sample rows, and the real
// candidate columns. Returns null on any failure so the caller falls back to the
// deterministic scorer (the importer must never go dead). Advisory only — the
// chosen target is still value-validated by bob-map-import + human approval.
async function reasonTargetMapping(args) {
  if (!BOB_INFERENCE_URL || !BOB_INFERENCE_SECRET) return null;
  try {
    const res = await fetch(BOB_INFERENCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bob-Secret': BOB_INFERENCE_SECRET
      },
      body: JSON.stringify({
        action: 'plan_import_mapping',
        headers: args.headers,
        sample_rows: args.sampleRows,
        candidate_tables: args.candidateTables,
        file_name: args.fileName
      })
    });
    if (!res.ok) return null;
    const data = await res.json().catch(()=>({}));
    if (!data || data.ok === false) return null;
    return {
      target_table: data.target_table ? String(data.target_table) : null,
      column_mapping: Array.isArray(data.column_mapping) ? data.column_mapping : [],
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      reasoning: typeof data.reasoning === 'string' ? data.reasoning : ''
    };
  } catch (_e) {
    return null;
  }
}
// ── CSV parsing (quoted cells, delimiter sniff, junk section-header skip) ──────
function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for(let i = 0; i < line.length; i++){
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
function sniffDelimiter(text) {
  const first = text.split(/\r?\n/).find((l)=>l.trim()) ?? '';
  if (first.includes('\t') && !first.includes(',')) return '\t';
  return ',';
}
// Find the header row by skipping junk/section rows: the header is the first
// line whose parsed cells are mostly non-empty and count > 1. This generalises
// (no hardcoded header names) and drops rows like 'Despatch Zone based Patrols'.
function parseCsv(text) {
  const delimiter = sniffDelimiter(text);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l)=>l.trim());
  if (!lines.length) return {
    headers: [],
    rows: []
  };
  let headerIdx = -1;
  for(let i = 0; i < lines.length; i++){
    const cells = parseDelimitedLine(lines[i], delimiter);
    const nonEmpty = cells.filter((c)=>c.trim()).length;
    if (cells.length > 1 && nonEmpty >= Math.max(2, Math.ceil(cells.length * 0.5))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return {
    headers: [],
    rows: []
  };
  const rawHeaders = parseDelimitedLine(lines[headerIdx], delimiter).map((h)=>h.trim());
  // Drop trailing empty header (files often end rows with a trailing delimiter).
  const headers = rawHeaders.filter((h, i)=>h !== '' || i < rawHeaders.length - 1);
  const rows = [];
  for (const line of lines.slice(headerIdx + 1)){
    const cells = parseDelimitedLine(line, delimiter);
    const nonEmpty = cells.filter((c)=>c.trim()).length;
    if (nonEmpty < 1) continue; // blank
    if (cells.length === 1 && headers.length > 1) continue; // junk/section line
    const rec = {};
    headers.forEach((h, i)=>{
      if (h) rec[h] = (cells[i] ?? '').trim();
    });
    rows.push(rec);
  }
  return {
    headers,
    rows
  };
}
function extractHeadersRows(body) {
  if (typeof body.document_text === 'string' && body.document_text.trim()) return parseCsv(body.document_text);
  if (Array.isArray(body.rows) && body.rows.length) {
    const set = new Set();
    for (const r of body.rows)if (r && typeof r === 'object') for (const k of Object.keys(r))set.add(k);
    return {
      headers: [
        ...set
      ],
      rows: body.rows
    };
  }
  if (Array.isArray(body.headers) && Array.isArray(body.sample_rows)) {
    const headers = body.headers.map((h)=>String(h ?? ''));
    const rows = body.sample_rows.map((r)=>{
      const rec = {};
      headers.forEach((h, i)=>{
        rec[h] = String(r?.[i] ?? '');
      });
      return rec;
    });
    return {
      headers,
      rows
    };
  }
  return {
    headers: [],
    rows: []
  };
}
async function callFn(fnName, authHeader, payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch  {
    data = {
      raw: text.slice(0, 500)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data
  };
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
    const cronHeader = req.headers.get('x-cron-secret') ?? '';
    const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let orgId = null;
    if (!isServiceRole && !isCron) {
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
      const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
      if (!profile || !CAN_PLAN.has(String(profile.role))) return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
      orgId = profile.organization_id;
    }
    const body = await req.json().catch(()=>({}));
    orgId = body.organization_id ?? orgId;
    const sampleSize = Math.max(1, Math.min(200, body.sample_size ?? DEFAULT_SAMPLE_SIZE));
    const maxCandidates = Math.max(1, Math.min(10, body.max_candidates ?? DEFAULT_MAX_CANDIDATES));
    const { headers, rows } = extractHeadersRows(body);
    if (!headers.length) return json({
      error: 'No headers found. Provide document_text, rows, or headers + sample_rows.'
    }, 400);
    // Recall any learned mapping for this document shape (warm start).
    const recall = await callFn('bob-import-memory', authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, {
      action: 'recall',
      headers,
      organization_id: orgId
    });
    const recalledTarget = recall.ok ? recall.data?.match?.target_table ?? null : null;
    // Candidate target tables. Explicit override wins; then any recalled target;
    // otherwise INFER from the live schema by scoring each public table on how
    // many of its columns the source headers plausibly hit. No hardcoded list.
    let candidates = [];
    let candidateScores = [];
    let modelChoice = null;
    if (Array.isArray(body.target_tables) && body.target_tables.length) {
      candidates = body.target_tables.map((t)=>String(t)).filter(Boolean);
    } else {
      // Fetch the live schema (ALL public tables). ROOT CAUSE (verified): the
      // RPC + its grants are HEALTHY (154 tables in SQL; service_role/authenticated
      // EXECUTE intact; security_definer=true; owner=postgres). Yet calling it
      // directly here via admin.rpc('bob_inspect_schema',{table_names:null})
      // returns 0 tables at runtime, while the SAME RPC returns 154 via the
      // bob-schema-inspect edge function. So the fault is the direct Deno
      // supabase-js .rpc() call path in THIS function, not the RPC/grants/schema.
      // Fix: use the PROVEN path — call bob-schema-inspect (returns full schema)
      // with the caller's auth. Direct RPC is kept only as a last-resort fallback.
      let tables = [];
      let schemaErr = null;
      const schemaAuth = authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
      // include_relationships:false -> bob-schema-inspect passes include_fks=false
      // to the RPC, skipping the expensive FK joins so the ALL-tables call does
      // NOT hit the edge statement timeout. Bob's planner only needs columns to
      // pick a target table, so relationships are not required here.
      const inspect = await callFn('bob-schema-inspect', schemaAuth, {
        include_relationships: false,
        include_constraints: false
      });
      if (inspect.ok && Array.isArray(inspect.data?.tables)) {
        tables = inspect.data.tables;
      } else {
        schemaErr = inspect.data?.error ?? `bob-schema-inspect returned ${inspect.status}`;
        // Fallback: direct RPC with the fast path (include_fks=false).
        const s1 = await admin.rpc('bob_inspect_schema', {
          table_names: null,
          include_fks: false
        });
        tables = s1.data?.tables ?? [];
        schemaErr = schemaErr ?? s1.error?.message ?? null;
      }
      console.log(`[bob-plan-import] schema tables=${tables.length} headers=${headers.length} via=${inspect.ok ? 'schema-inspect' : 'rpc-fallback'}`);
      const targetableTables = tables.filter((t)=>isTargetable(String(t.table))).map((t)=>({
          table: String(t.table),
          columns: (t.columns ?? []).map((c)=>({
              name: String(c.name),
              data_type: c.data_type,
              nullable: c.nullable
            }))
        }));
      // Preflight guard (defence-in-depth): if the live schema could not be read,
      // do NOT call the reasoner with an empty candidate set (it would 400) and
      // do NOT silently fall through to an empty scorer (confusing "no candidate").
      // Return a clear, actionable diagnostic instead.
      if (!targetableTables.length) {
        return json({
          success: true,
          file_name: body.file_name ?? null,
          headers,
          row_count: rows.length,
          recalled_target: recalledTarget,
          candidates: [],
          plan: null,
          selection_method: 'none',
          note: 'I could not read the live database schema to find a target table (schema inspection returned no tables). This is a configuration/permissions issue with bob_inspect_schema, not your file. Nothing was written.',
          diagnostic: {
            schema_tables: tables.length,
            schema_error: schemaErr
          }
        });
      }
      const sampleObjects = rows.slice(0, Math.min(sampleSize, 8));
      modelChoice = await reasonTargetMapping({
        headers,
        sampleRows: sampleObjects,
        candidateTables: targetableTables,
        fileName: String(body.file_name ?? 'uploaded-file')
      });
      const normHeaders = headers.map(normKey).filter(Boolean);
      const headerSet = new Set(normHeaders);
      // Header tokens for overlap scoring (drop tiny/common tokens).
      const stopTokens = new Set([
        'id',
        'the',
        'of',
        'no',
        'to',
        'on',
        'in',
        'is',
        'ex',
        'gst',
        'date',
        'time',
        'type',
        'name',
        'status'
      ]);
      const headerTokens = new Set(normHeaders.flatMap((h)=>h.split('_')).filter((tok)=>tok.length >= 3 && !stopTokens.has(tok)));
      // Synonym-aware, token-aware candidate scoring. FALLBACK ONLY (used when the
      // model brain is unavailable or unsure). Exact match strongest, then a known
      // synonym, then a shared significant token.
      const scored = tables.filter((t)=>isTargetable(String(t.table))).map((t)=>{
        const cols = t.columns ?? [];
        let score = 0;
        const colTokenIndex = new Map(); // token -> column
        for (const c of cols){
          const cn = normKey(c.name);
          for (const tok of cn.split('_'))if (tok.length >= 3 && !stopTokens.has(tok)) colTokenIndex.set(tok, cn);
        }
        for (const c of cols){
          const cn = normKey(c.name);
          if (!cn) continue;
          if (headerSet.has(cn)) {
            score += 1.0;
            continue;
          } // exact
          let synHit = false;
          for (const h of normHeaders){
            if (SYNONYMS[h] && normKey(SYNONYMS[h]) === cn) {
              synHit = true;
              break;
            }
          }
          if (synHit) {
            score += 0.9;
            continue;
          }
        }
        let tokenHits = 0;
        for (const [tok] of colTokenIndex)if (headerTokens.has(tok)) tokenHits += 1;
        score += Math.min(tokenHits, 6) * 0.5;
        return {
          table: String(t.table),
          score: Number(score.toFixed(2))
        };
      }).filter((x)=>x.score >= 1.5).sort((a, b)=>b.score - a.score);
      candidateScores = scored.slice(0, maxCandidates);
      candidates = candidateScores.map((x)=>x.table);
      // Merge: the model's chosen target leads (still validated downstream), then
      // the recalled target, then the scorer's candidates. De-duplicated.
      const modelTarget = modelChoice?.target_table && isTargetable(modelChoice.target_table) ? modelChoice.target_table : null;
      const ordered = [];
      for (const t of [
        modelTarget,
        recalledTarget,
        ...candidates
      ]){
        if (t && !ordered.includes(t)) ordered.push(t);
      }
      candidates = ordered.slice(0, Math.max(maxCandidates, 1));
    }
    if (!candidates.length) {
      return json({
        success: true,
        file_name: body.file_name ?? null,
        headers,
        row_count: rows.length,
        recalled_target: recalledTarget,
        candidates: [],
        plan: null,
        note: 'No candidate target table scored high enough. Bob should decode codes / reason about entities, or a target_table should be supplied. No hardcoded targets exist.'
      });
    }
    // Value-validate + confidence for each candidate via bob-map-import.
    const sampleRows = rows.slice(0, sampleSize).map((r)=>headers.map((h)=>r[h] ?? ''));
    const mappings = [];
    for (const table of candidates){
      const m = await callFn('bob-map-import', authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, {
        headers,
        sample_rows: sampleRows,
        target_table: table,
        sample_size: sampleSize,
        organization_id: orgId
      });
      if (m.ok) mappings.push(m.data);
    }
    mappings.sort((a, b)=>(b?.validated_columns_count ?? 0) - (a?.validated_columns_count ?? 0));
    const best = mappings[0] ?? null;
    // Build a governed, dry-run PLAN for bob-job-runner. Every step is a dry-run
    // generic_upsert; no step is approved. The conductor/user approves before any
    // live write. This function performs no writes itself.
    const plan = best && best.confident ? {
      goal: `Import ${body.file_name ?? 'document'} into ${best.target_table} (dry-run preview)`,
      parent_agent: 'bob',
      approval_mode: 'required',
      constraints: [
        'dry_run_preview'
      ],
      steps: [
        {
          id: 's1',
          tool: 'schema_inspect',
          params: {
            tables: [
              best.target_table
            ]
          }
        },
        {
          id: 's2',
          tool: 'generic_upsert',
          params: {
            table: best.target_table,
            mode: 'create',
            dry_run: true,
            data: rows[0] ?? {},
            provenance: {
              source: body.file_name ?? 'bob-plan-import',
              confidence: 'medium'
            }
          },
          approved: false,
          app_surface: 'bob_import'
        }
      ]
    } : null;
    return json({
      success: true,
      file_name: body.file_name ?? null,
      headers,
      row_count: rows.length,
      recalled_target: recalledTarget,
      candidates,
      candidate_scores: candidateScores,
      model_choice: modelChoice ? {
        target_table: modelChoice.target_table,
        column_mapping: modelChoice.column_mapping,
        confidence: modelChoice.confidence,
        reasoning: modelChoice.reasoning
      } : null,
      selection_method: modelChoice?.target_table ? 'model' : candidates.length ? 'scorer' : 'none',
      sample_rows_objects: rows.slice(0, sampleSize),
      mappings,
      best_target: best?.target_table ?? null,
      confident: best?.confident ?? false,
      plan,
      note: best?.confident ? 'Confident candidate found. ALWAYS show the mapping to the user, then run the dry-run plan via bob-job-runner (governed) before any live write. This planner wrote nothing.' : 'No confident candidate. Show the proposed mappings and ASK the user to confirm the target/mapping (or decode codes / reason further) before proceeding. This planner wrote nothing.'
    });
  } catch (err) {
    console.error('[bob-plan-import] error:', err);
    return json({
      error: 'Import planning failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
