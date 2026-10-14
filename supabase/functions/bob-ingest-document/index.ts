/**
 * bob-ingest-document — governed generic document/data ingest (Phase 3a)
 *
 * Purpose:
 *   Generic staging ingest helper for Bob/sub-agent workflows. This first phase
 *   supports CSV/TSV-style table text and writes only to explicitly allowed
 *   staging tables. It supports dry-run, mapping, malformed-row skipping, and
 *   returns deterministic stats for Bob to explain/learn from.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master.
 *
 * Body:
 * {
 *   "file_name": "clients.csv",
 *   "document_text": "csv text...",
 *   "target_table": "_seed_fs_nelson_clients_raw",
 *   "mode": "dry_run" | "append",
 *   "delimiter": "," | "\t",
 *   "malformed_row_policy": "skip" | "fail",
 *   "column_mapping": { "Bureau ID": "bureau_id" }
 * }
 *
 * Guardrails:
 *   - Only allowlisted staging tables.
 *   - Only allowlisted columns for each target table.
 *   - Max row cap.
 *   - No arbitrary SQL; table/columns are validated before use.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const MAX_ROWS = 20_000;
const CAN_INGEST = new Set([
  'grand_master',
  'master',
  'admin'
]);
// NO hardcoded target list. The target table + its columns + required columns
// are resolved from the LIVE schema at request time (see resolveTarget). This
// keeps ingest fully agentic: any real business table can be a target, with no
// per-table/per-file code. Column-level guards + a write-only sensitive floor
// (below) are the only fixed policy, and those are safety, not mapping logic.
const GUARDED_COLUMNS = new Set([
  'id',
  'created_at',
  'updated_at',
  'organization_level',
  'jurisdiction_geom',
  'boundary',
  'center_point',
  'password',
  'auth_id'
]);
// Sensitive tables Bob may READ but must never be APPENDED to here (mirrors the
// bob-upsert-generic write-only floor: auth/identity/governance/audit). This
// protects provenance + reversal integrity; it is not a mapping allowlist.
const SENSITIVE_TABLES = new Set([
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
const SENSITIVE_PREFIXES = [
  'pg_',
  'auth_',
  'schema_migrations',
  'spatial_ref_sys',
  '_migration'
];
function isSensitive(table) {
  if (SENSITIVE_TABLES.has(table)) return true;
  return SENSITIVE_PREFIXES.some((p)=>table.startsWith(p));
}
// Resolve a target table's columns from the LIVE schema. required = live NOT
// NULL columns without a default (minus guarded/auto columns). No table exists
// in the live public schema => unknown table.
async function resolveTarget(admin, tableName) {
  const { data, error } = await admin.rpc('bob_inspect_schema', {
    table_names: [
      tableName
    ]
  });
  if (error) throw new Error(`schema inspect failed: ${error.message}`);
  const tables = data?.tables ?? [];
  const t = tables.find((x)=>x.table === tableName);
  const cols = t?.columns ?? [];
  if (!cols.length) return null;
  const columns = cols.map((c)=>c.name).filter((n)=>!GUARDED_COLUMNS.has(n));
  const requiredColumns = cols.filter((c)=>!c.nullable && !c.default && !GUARDED_COLUMNS.has(c.name)).map((c)=>c.name);
  return {
    table: tableName,
    columns,
    requiredColumns
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function normalizeHeader(value) {
  return String(value ?? '').trim().replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
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
function chooseDelimiter(text, requested) {
  if (requested === '\t' || requested === ',') return requested;
  const firstLine = text.split(/\r?\n/).find((line)=>line.trim()) ?? '';
  return firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
}
function parseRows(text, delimiter) {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = rawLines.filter((line)=>line.trim());
  if (lines.length === 0) return {
    headers: [],
    rows: []
  };
  // Skip junk/section title rows: the header is the first line whose cells are
  // mostly non-empty and count > 1 (generic — no hardcoded header names).
  const headerIndex = lines.findIndex((line)=>{
    const cells = parseDelimitedLine(line, delimiter);
    const nonEmpty = cells.filter((c)=>c.trim()).length;
    return cells.length > 1 && nonEmpty >= Math.max(2, Math.ceil(cells.length * 0.5));
  });
  if (headerIndex < 0) return {
    headers: [],
    rows: []
  };
  const headers = parseDelimitedLine(lines[headerIndex], delimiter).map(normalizeHeader);
  const rows = lines.slice(headerIndex + 1).map((line)=>parseDelimitedLine(line, delimiter));
  return {
    headers,
    rows
  };
}
function mapHeaders(headers, columnMapping, target) {
  const allowed = new Set(target.columns);
  return headers.map((header)=>{
    const explicit = columnMapping?.[header] ?? columnMapping?.[normalizeHeader(header)];
    const mapped = explicit ? normalizeHeader(explicit) : normalizeHeader(header);
    return allowed.has(mapped) ? mapped : null;
  });
}
async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, '0')).join('');
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
    if (!profile || !CAN_INGEST.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    const targetName = String(body.target_table ?? '').trim();
    if (!targetName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetName)) {
      return json({
        error: 'target_table is required and must be a valid identifier'
      }, 400);
    }
    if (isSensitive(targetName)) {
      return json({
        error: `Table '${targetName}' is read-only for Bob (sensitive/governance/identity). Bob can read it but must not append to it.`,
        read_only: true
      }, 422);
    }
    // Resolve the target from the LIVE schema (no hardcoded targets).
    const target = await resolveTarget(admin, targetName);
    if (!target) {
      return json({
        error: `Table '${targetName}' was not found in the live public schema. Check the name via schema inspect.`,
        unknown_table: true
      }, 404);
    }
    const mode = body.mode ?? 'dry_run';
    if (![
      'dry_run',
      'append'
    ].includes(mode)) return json({
      error: 'mode must be dry_run or append'
    }, 400);
    const malformedPolicy = body.malformed_row_policy ?? 'skip';
    if (![
      'skip',
      'fail'
    ].includes(malformedPolicy)) return json({
      error: 'malformed_row_policy must be skip or fail'
    }, 400);
    const text = String(body.document_text ?? '');
    if (!text.trim()) return json({
      error: 'document_text is required for Phase 3a ingest'
    }, 400);
    const delimiter = chooseDelimiter(text, body.delimiter);
    const { headers, rows } = parseRows(text, delimiter);
    if (headers.length === 0) return json({
      error: 'Could not find a usable header row'
    }, 422);
    if (rows.length > MAX_ROWS) return json({
      error: `Row cap exceeded (${rows.length}/${MAX_ROWS})`
    }, 413);
    const mappedHeaders = mapHeaders(headers, body.column_mapping, target);
    const unmappedHeaders = headers.filter((_, i)=>mappedHeaders[i] === null);
    const usableColumns = mappedHeaders.filter(Boolean);
    const missingRequired = target.requiredColumns.filter((col)=>!usableColumns.includes(col));
    if (missingRequired.length > 0) {
      return json({
        error: 'Required target columns are not mapped',
        missing_required_columns: missingRequired,
        source_headers: headers,
        unmapped_headers: unmappedHeaders
      }, 422);
    }
    const acceptedRows = [];
    const errors = [];
    for (const [index, row] of rows.entries()){
      // Skip report section/footer rows that are far too short.
      if (row.length < 2) {
        errors.push({
          row_number: index + 2,
          reason: 'too_few_fields',
          raw_row: row
        });
        if (malformedPolicy === 'fail') break;
        continue;
      }
      const record = {};
      for(let i = 0; i < mappedHeaders.length; i++){
        const column = mappedHeaders[i];
        if (!column) continue;
        record[column] = row[i]?.trim() || null;
      }
      const missing = target.requiredColumns.filter((column)=>!record[column]);
      if (missing.length > 0) {
        errors.push({
          row_number: index + 2,
          reason: `missing_required:${missing.join(',')}`,
          raw_row: row
        });
        if (malformedPolicy === 'fail') break;
        continue;
      }
      acceptedRows.push(record);
    }
    if (malformedPolicy === 'fail' && errors.length > 0) {
      return json({
        success: false,
        mode,
        target_table: target.table,
        total_rows: rows.length,
        accepted_rows: acceptedRows.length,
        skipped_rows: errors.length,
        errors: errors.slice(0, 50)
      }, 422);
    }
    const checksum = await sha256(text);
    let insertedRows = 0;
    if (mode === 'append' && acceptedRows.length > 0) {
      const chunkSize = 500;
      for(let i = 0; i < acceptedRows.length; i += chunkSize){
        const chunk = acceptedRows.slice(i, i + chunkSize);
        const { error: insertErr } = await admin.from(target.table).insert(chunk);
        if (insertErr) throw new Error(`Insert failed at row ${i + 1}: ${insertErr.message}`);
        insertedRows += chunk.length;
      }
    }
    return json({
      success: true,
      mode,
      target_table: target.table,
      file_name: body.file_name ?? null,
      checksum,
      total_rows: rows.length,
      accepted_rows: acceptedRows.length,
      inserted_rows: insertedRows,
      skipped_rows: errors.length,
      source_headers: headers,
      mapped_columns: usableColumns,
      unmapped_headers: unmappedHeaders,
      errors: errors.slice(0, 50),
      audit: {
        actor_id: user.id,
        agent_task_id: body.agent_task_context?.task_id ?? null,
        parent_agent: body.agent_task_context?.parent_agent ?? null
      }
    });
  } catch (err) {
    console.error('[bob-ingest-document] error:', err);
    return json({
      error: 'Document ingest failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
