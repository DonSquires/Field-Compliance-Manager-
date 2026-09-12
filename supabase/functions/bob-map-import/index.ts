/**
 * bob-map-import — schema detection + data-value confidence engine
 *
 * Purpose (the value-validation step BEFORE bob-upsert-generic):
 *   Given a batch of parsed rows (headers + sample values) and a candidate
 *   target table, Bob:
 *     1. inspects the LIVE schema (bob_inspect_schema RPC — no guessing),
 *     2. maps each source header to a real column (exact -> normalized ->
 *        synonym, the SAME conventions as bob-upsert-generic),
 *     3. VALUE-VALIDATES: checks that the sampled data for each mapped column
 *        actually matches that column's destination data type, and
 *     4. computes a confidence GATE and always returns the proposed mapping.
 *
 * Owner confidence rule (do not soften):
 *   Bob is confident ONLY when there are >=3 columns where the header maps AND
 *   the sampled data matches the destination column type. Otherwise the result
 *   is needs_confirmation and the caller must show the proposed mapping and ask.
 *
 * This function NEVER writes. It is pure read-only planning; execution goes
 * through bob-upsert-generic (per row) after a human approves the mapping.
 * bob-import-memory recall/learn wraps this (warm-start + persist on approve).
 *
 * Auth (mirrors bob-schema-inspect): service-role/cron OR a JWT whose profile
 * role is admin/master/grand_master.
 *
 * Body:
 *   {
 *     "rows": [ { "Client ID": "391224", "Site Name": "...", ... }, ... ],
 *     // or explicit split:
 *     "headers": ["Client ID", "Site Name", ...],
 *     "sample_rows": [ ["391224", "..."], ... ],
 *     "target_table": "client_sites",   // required candidate destination
 *     "sample_size": 25,                  // rows sampled for value checks
 *     "organization_id": "uuid"           // for service-role callers
 *   }
 *
 * Response:
 *   {
 *     success, target_table, confident (bool), confidence_score, signature,
 *     mapping: [ { source, column, data_type, value_match, samples_checked,
 *                  samples_matched } ],
 *     unmapped_headers, matched_columns_count, validated_columns_count,
 *     missing_required, note
 *   }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
const CAN_MAP = new Set([
  'grand_master',
  'master',
  'admin'
]);
// Owner rule: confident only with >=3 columns where header maps AND data matches type.
const CONFIDENCE_MIN_VALIDATED_COLUMNS = 3;
const DEFAULT_SAMPLE_SIZE = 25;
const MAX_SAMPLE_SIZE = 200;
// Column-level safety floor: same guarded set as bob-upsert-generic. These are
// never mapping targets (system/auth/RLS/trigger-managed).
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
// Same synonym table as bob-upsert-generic so mapping is consistent end-to-end.
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
// Business-required fields beyond DB NOT NULL (mirrors bob-upsert-generic so the
// dry-run downstream will not surprise the user).
const BUSINESS_REQUIRED = {
  organizations: [
    'name'
  ],
  client_sites: [
    'name'
  ],
  crm_contacts: [
    'organization_id',
    'first_name',
    'last_name'
  ],
  service_agreements: [
    'provider_organization_id',
    'client_organization_id',
    'name'
  ],
  invoices: [
    'organization_id'
  ],
  staff_credentials: [
    'staff_id',
    'organization_id',
    'credential_type'
  ],
  shift_templates: [
    'organization_id',
    'name',
    'shift_type',
    'start_time',
    'end_time'
  ]
};
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
// Header fingerprint identical to bob-import-memory.fingerprint so a mapping
// recalled/learned there matches what this engine computes.
function fingerprint(headers) {
  const arr = Array.isArray(headers) ? headers : String(headers ?? '').split(',');
  const norm = arr.map((h)=>String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).filter(Boolean);
  return [
    ...new Set(norm)
  ].sort().join('|');
}
async function loadColumns(admin, table) {
  const { data, error } = await admin.rpc('bob_inspect_schema', {
    table_names: [table],
    include_fks: false
  });
  if (error) throw new Error(`schema inspect failed: ${error.message}`);
  const tables = data?.tables ?? [];
  const t = tables.find((x)=>x.table === table);
  return t?.columns ?? [];
}
// Classify a Postgres data_type into a coarse family for value validation.
function typeFamily(dataType) {
  const t = String(dataType ?? '').toLowerCase();
  if (/(int|numeric|decimal|real|double|money|serial)/.test(t)) return 'number';
  if (/bool/.test(t)) return 'boolean';
  if (/(timestamp|date|time)/.test(t)) return 'date';
  if (/uuid/.test(t)) return 'uuid';
  if (/(json|jsonb)/.test(t)) return 'json';
  return 'text';
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOL_SET = new Set([
  'true',
  'false',
  't',
  'f',
  'yes',
  'no',
  'y',
  'n',
  '0',
  '1'
]);
// Does a single scalar value plausibly match the destination type family?
// Blank/null values are treated as non-informative (do not count for or against).
function valueMatchesType(value, family) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  switch(family){
    case 'number':
      return /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(s);
    case 'boolean':
      return BOOL_SET.has(s.toLowerCase());
    case 'uuid':
      return UUID_RE.test(s);
    case 'date':
      return !Number.isNaN(Date.parse(s));
    case 'json':
      {
        try {
          JSON.parse(s);
          return true;
        } catch  {
          return typeof value === 'object';
        }
      }
    case 'text':
    default:
      return true; // any non-empty scalar is acceptable text
  }
}
// Normalize the incoming body into { headers, sampleRows } regardless of whether
// the caller sent an array of row-objects or an explicit headers + sample_rows.
function extractRows(body) {
  if (Array.isArray(body.headers) && Array.isArray(body.sample_rows)) {
    const headers = body.headers.map((h)=>String(h ?? ''));
    const sampleRows = body.sample_rows.map((r)=>Array.isArray(r) ? r : [
        r
      ]);
    return {
      headers,
      sampleRows
    };
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return {
    headers: [],
    sampleRows: []
  };
  // Union of keys across sampled objects preserves headers even if the first
  // row is sparse.
  const headerSet = new Set();
  for (const r of rows)if (r && typeof r === 'object') for (const k of Object.keys(r))headerSet.add(k);
  const headers = [
    ...headerSet
  ];
  const sampleRows = rows.map((r)=>headers.map((h)=>r?.[h]));
  return {
    headers,
    sampleRows
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
    const body = await req.json().catch(()=>({}));
    // Auth: service-role/cron, else admin/master/grand_master JWT.
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
      const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
      if (!profile || !CAN_MAP.has(String(profile.role))) {
        return json({
          error: 'Forbidden: admin/master/grand_master required'
        }, 403);
      }
    }
    const targetTable = String(body.target_table ?? '').trim();
    if (!targetTable) {
      return json({
        error: 'target_table is required (the candidate destination to map against).'
      }, 400);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetTable)) {
      return json({
        error: 'target_table is not a valid identifier.'
      }, 400);
    }
    const { headers, sampleRows } = extractRows(body);
    if (!headers.length) {
      return json({
        error: 'No headers found. Provide `rows` (array of objects) or `headers` + `sample_rows`.'
      }, 400);
    }
    const signature = fingerprint(headers);
    const sampleSize = Math.min(Math.max(1, body.sample_size ?? DEFAULT_SAMPLE_SIZE), MAX_SAMPLE_SIZE);
    const sample = sampleRows.slice(0, sampleSize);
    // Live schema for the candidate table. Existence is proven by the schema
    // itself: no columns => the table does not exist in the public schema.
    const cols = await loadColumns(admin, targetTable);
    if (!cols.length) {
      return json({
        error: `Table '${targetTable}' was not found in the live public schema. Check the name via schema inspect.`,
        unknown_table: true
      }, 404);
    }
    const colByName = new Map(cols.map((c)=>[
        c.name,
        c
      ]));
    const colByNorm = new Map(cols.map((c)=>[
        normKey(c.name),
        c
      ]));
    const resolveColumn = (header)=>{
      let col = colByName.get(header) ?? colByNorm.get(normKey(header));
      if (!col) {
        const syn = SYNONYMS[normKey(header)];
        if (syn) col = colByName.get(syn) ?? colByNorm.get(normKey(syn));
      }
      if (col && GUARDED_COLUMNS.has(col.name)) return undefined; // never map guarded cols
      return col;
    };
    const mapping = [];
    const unmapped = [];
    const usedColumns = new Set();
    headers.forEach((header, idx)=>{
      const col = resolveColumn(header);
      if (!col || usedColumns.has(col.name)) {
        // Unmapped, or the column was already claimed by an earlier header.
        if (!col) unmapped.push(header);
        else mapping.push({
          source: header,
          column: null,
          data_type: null,
          value_match: false,
          samples_checked: 0,
          samples_matched: 0
        });
        return;
      }
      usedColumns.add(col.name);
      const family = typeFamily(col.data_type);
      let checked = 0;
      let matched = 0;
      for (const row of sample){
        const v = Array.isArray(row) ? row[idx] : undefined;
        const res = valueMatchesType(v, family);
        if (res === null) continue; // blank/non-informative
        checked += 1;
        if (res) matched += 1;
      }
      // A column's data "matches the destination type" when we saw at least one
      // informative sample and every informative sample matched. If there were no
      // informative samples we cannot confirm the value match (counts as false
      // for the confidence gate, but the header mapping still stands).
      const valueMatch = checked > 0 && matched === checked;
      mapping.push({
        source: header,
        column: col.name,
        data_type: col.data_type,
        value_match: valueMatch,
        samples_checked: checked,
        samples_matched: matched
      });
    });
    const matchedColumnsCount = mapping.filter((m)=>m.column).length;
    const validatedColumnsCount = mapping.filter((m)=>m.column && m.value_match).length;
    const confident = validatedColumnsCount >= CONFIDENCE_MIN_VALIDATED_COLUMNS;
    // Required-but-unmapped (mirrors bob-upsert-generic create-mode requirements).
    const dbRequired = cols.filter((c)=>!c.nullable && !c.default && !GUARDED_COLUMNS.has(c.name)).map((c)=>c.name);
    const required = [
      ...new Set([
        ...BUSINESS_REQUIRED[targetTable] ?? [],
        ...dbRequired
      ])
    ];
    const missingRequired = required.filter((r)=>!usedColumns.has(r));
    return json({
      success: true,
      target_table: targetTable,
      signature,
      confident,
      confidence_score: validatedColumnsCount,
      confidence_rule: `>=${CONFIDENCE_MIN_VALIDATED_COLUMNS} columns where header maps AND data matches destination type`,
      matched_columns_count: matchedColumnsCount,
      validated_columns_count: validatedColumnsCount,
      samples_used: sample.length,
      mapping,
      unmapped_headers: unmapped,
      missing_required: missingRequired,
      note: confident ? 'Confident mapping proposed. Still always show the mapping to the user, then dry-run per row via bob-upsert-generic before executing.' : 'Not confident (value-validated columns below threshold). Show the proposed mapping and ASK the user to confirm before any dry-run.'
    });
  } catch (err) {
    console.error('[bob-map-import] error:', err);
    return json({
      error: 'Import mapping failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
