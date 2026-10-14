/**
 * bob-upsert-generic — schema-driven governed create/update executor (v2)
 *
 * Philosophy (agentic, not hardcoded):
 *   Bob inspects the LIVE table schema, maps request/document fields to real
 *   columns, drops unknown fields, detects missing REQUIRED fields, and returns
 *   clarifying questions instead of failing. No per-entity hardcoded column
 *   lists. This is the flexible replacement for the hardcoded bob-upsert-entity
 *   branches (which drift from schema and break).
 *
 * Safety is preserved by CONFIG, not by hardcoding every column:
 *   - TABLE_ALLOWLIST: only these tables may be written.
 *   - GUARDED_COLUMNS: never writable from here (ids, auth, RLS-critical).
 *   - AUTH_DELEGATE: tables whose creation must go via a dedicated function
 *     (e.g. user creation -> create-user). Blocked here.
 *   - dedupe hints per table.
 *   - dry-run default, provenance required, human-invoked/service-role.
 *
 * Body:
 *   {
 *     "table": "client_sites",
 *     "mode": "create" | "update",
 *     "dry_run": true,
 *     "human_invoked": true,
 *     "data": { ...arbitrary field keys from request/doc... },
 *     "target_id": "uuid (update)",
 *     "provenance": { "source": "...", "confidence": "high|medium|low" }
 *   }
 *
 * Response (dry-run) includes: mapped_columns, dropped_fields,
 *   missing_required (-> clarifying_questions), planned_row.
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
const CAN_WRITE_ROLES = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
// ── Access matrix (C2, issue #3) ─────────────────────────────────────────────
// Rank floor first, then area x level. Officers never reach this executor for
// management tables; grand_master/master and service-role bypass the area check.
// Mirrors packages/shared/src/accessAreas.ts (kept in lockstep; Deno cannot
// import the workspace package here). LEVEL: view<verify<approve<adjust<manage.
const ADMIN_LEVEL = 4;
const ROLE_LEVEL = {
  grand_master: 6,
  master: 5,
  admin: 4,
  admin_officer: 4,
  officer: 2,
  scan_operator: 2
};
const LEVEL_ORDER = [
  'view',
  'verify',
  'approve',
  'adjust',
  'manage'
];
function levelAtLeast(have, need) {
  if (!have) return false;
  return LEVEL_ORDER.indexOf(have) >= LEVEL_ORDER.indexOf(need);
}
// area -> writable tables (subset that flows through the generic executor).
const AREA_WRITABLE = {
  roster: [
    'shifts',
    'rosters',
    'roster_assignments',
    'roster_templates',
    'shift_templates',
    'shift_swaps',
    'timesheets',
    'on_call_periods',
    'staff_availability'
  ],
  dispatch: [
    'dispatch_jobs',
    'location_zones'
  ],
  ops: [
    'patrol_routes',
    'patrol_route_checkpoints',
    'patrol_route_sites',
    'client_site_patrol_config',
    'key_sets'
  ],
  patrol: [
    'patrol_checkpoints'
  ],
  compliance: [
    'module_rule_sets'
  ],
  enforcement: [
    'parking_infringement_notices',
    'observations'
  ],
  investigations: [
    'entity_flags',
    'entity_links'
  ],
  crm: [
    'crm_contacts',
    'organizations',
    'client_sites',
    'site_services'
  ],
  finance: [
    'invoices',
    'invoice_line_items',
    'quotes',
    'quote_lines',
    'crm_commercial_settings',
    'site_financial_config',
    'org_rate_settings',
    'rate_rules',
    'org_module_subscriptions'
  ],
  payroll: [
    'payroll_export_batches'
  ],
  hr: [
    'staff_profiles',
    'staff_credentials',
    'staff_skills',
    'leave_requests',
    'staff_documents'
  ],
  assets: [
    'assets',
    'asset_checks'
  ],
  org_setup: [
    'organization_modules',
    'service_agreements',
    'service_agreement_modules'
  ],
  platform: [
    'module_catalog'
  ]
};
const MANAGEMENT_AREAS = new Set([
  'roster',
  'ops',
  'compliance',
  'reports',
  'crm',
  'finance',
  'payroll',
  'hr',
  'users',
  'org_setup',
  'data_management',
  'platform'
]);
const CONFIG_TABLES = new Set([
  'org_rate_settings',
  'rate_rules',
  'crm_commercial_settings',
  'site_financial_config',
  'module_catalog',
  'org_module_subscriptions',
  'module_rule_sets',
  'organization_modules',
  'service_agreements',
  'service_agreement_modules',
  'roster_templates',
  'shift_templates',
  'client_site_patrol_config'
]);
const _TABLE_AREA = new Map();
for (const [area, tables] of Object.entries(AREA_WRITABLE)){
  for (const t of tables)if (!_TABLE_AREA.has(t)) _TABLE_AREA.set(t, area);
}
function areaForTable(table) {
  return _TABLE_AREA.get(table) ?? null;
}
function writeLevelForTable(table) {
  return CONFIG_TABLES.has(table) ? 'manage' : 'adjust';
}
// Bob has free access to the LIVE build: it discovers writable tables from the
// live schema (bob_inspect_schema) rather than a hardcoded allowlist. Safety is
// enforced by (a) auth-delegation for identity tables, (b) a read-only deny-list
// for sensitive tables, (c) guarded columns, and (d) governance (approval +
// dedupe + audit + reverse). Add a data-entry area by simply creating its table;
// no per-table code needed.
// Tables whose CREATE must go through a dedicated auth-aware function.
const AUTH_DELEGATE = {
  user_profiles: 'create-user'
};
// READ-ONLY (sensitive) tables: Bob may READ these (via schema-inspect and normal
// RLS-scoped reads) but must NEVER WRITE them here. Verified against the live
// public schema (2026-07-04). Covers Bob's own governance + memory + audit trail,
// auth/identity/access-control, security/audit logs, and seed/system tables.
// Matched by exact name or prefix.
const READ_ONLY_TABLES = new Set([
  // Bob governance, memory + audit (integrity of the approve/execute/reverse loop
  // and of Bob's own learning; a write must never edit these)
  'bob_job_runs',
  'bob_job_rollback_refs',
  'bob_agentic_actions',
  'bob_knowledge_cards',
  'bob_context_memory',
  'bob_learning_memory',
  'bob_messages',
  'bob_conversations',
  'bob_attachments',
  // auth / identity / access control (managed by auth flows + RLS + dedicated fns)
  'user_profiles',
  'provider_client_access_grants',
  'staff_branch_authorisations',
  // audit / security logs (append-only system-of-record; never Bob-written)
  'audit_log',
  'user_management_audit',
  'key_audit_settings',
  'officer_gps_log',
  // raw import/seed staging (governed ingest owns these, not the upsert executor)
  '_seed_fs_nelson_clients_raw'
]);
const READ_ONLY_PREFIXES = [
  'pg_',
  'auth_',
  '_seed_',
  'schema_migrations',
  'spatial_ref_sys'
];
function isReadOnlyTable(table) {
  if (READ_ONLY_TABLES.has(table)) return true;
  return READ_ONLY_PREFIXES.some((p)=>table.startsWith(p));
}
// Dedupe hints: table -> columns that identify a likely duplicate on create.
const DEDUPE_HINTS = {
  organizations: [
    [
      'name',
      'organization_type'
    ]
  ],
  client_sites: [
    [
      'address_match_key'
    ]
  ],
  crm_contacts: [
    [
      'organization_id',
      'email'
    ]
  ],
  invoices: [
    [
      'organization_id',
      'invoice_number'
    ]
  ],
  staff_credentials: [
    [
      'staff_id',
      'credential_type',
      'credential_number'
    ]
  ]
};
// Business-required fields beyond DB NOT NULL (helps ask better questions).
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
// Never writable from here (managed by system / auth / RLS / triggers). This is
// a column-level safety floor that applies to EVERY table Bob writes.
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
// Map arbitrary incoming keys to real columns. Exact match first, then
// normalized-name match, then a small synonym table.
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
function mapFields(data, cols) {
  const colByName = new Map(cols.map((c)=>[
      c.name,
      c
    ]));
  const colByNorm = new Map(cols.map((c)=>[
      normKey(c.name),
      c
    ]));
  const mapped = {};
  const dropped = [];
  for (const [k, v] of Object.entries(data)){
    let col = colByName.get(k) ?? colByNorm.get(normKey(k));
    if (!col) {
      const syn = SYNONYMS[normKey(k)];
      if (syn) col = colByName.get(syn) ?? colByNorm.get(normKey(syn));
    }
    if (!col) {
      dropped.push(k);
      continue;
    }
    if (GUARDED_COLUMNS.has(col.name)) {
      dropped.push(`${k} (guarded)`);
      continue;
    }
    mapped[col.name] = v;
  }
  return {
    mapped,
    dropped
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
    const body = await req.json();
    let actorId = null;
    let actorRole = 'service';
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
      if (!profile || !CAN_WRITE_ROLES.has(String(profile.role))) return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
      if (body.human_invoked !== true) return json({
        error: 'human_invoked_required'
      }, 403);
      actorId = user.id;
      actorRole = String(profile.role);
    }
    const table = String(body.table ?? '').trim();
    const mode = body.mode ?? 'create';
    const dryRun = body.dry_run !== false;
    const data = body.data ?? {};
    const provenance = body.provenance ?? {};
    if (!table) return json({
      error: 'table is required'
    }, 400);
    if (AUTH_DELEGATE[table]) return json({
      error: `Writing '${table}' must go through '${AUTH_DELEGATE[table]}' (auth-sensitive).`,
      delegate: AUTH_DELEGATE[table]
    }, 422);
    if (isReadOnlyTable(table)) return json({
      error: `Table '${table}' is read-only for Bob (sensitive/governance table). Bob can read it but must not write it.`,
      read_only: true
    }, 422);
    if (!provenance.source) return json({
      error: 'provenance.source is required (data lineage)'
    }, 400);
    // ── C2 access matrix (issue #3): rank floor + area x level ────────────────
    // Skipped for service-role/cron (actorId null) and grand_master/master, who
    // retain full access (non-regression). For admin/admin_officer actors the
    // area's rank floor + the caller's resolved level must permit the write.
    if (actorId && actorRole !== 'grand_master' && actorRole !== 'master') {
      const area = areaForTable(table);
      if (area) {
        // Rank floor: management areas require admin-tier (>= 4). Officers can
        // never satisfy this - "roster must be an admin".
        if (MANAGEMENT_AREAS.has(area) && (ROLE_LEVEL[actorRole] ?? 0) < ADMIN_LEVEL) {
          return json({
            error: `Forbidden: '${area}' is an admin-tier area.`,
            area,
            rank_denied: true
          }, 403);
        }
        // Fail-open when UNCONFIGURED (rollout safety, matches AdminShell's
        // isPageEnabled "unconfigured => fail open"). If this admin-tier user has
        // NO direct grants AND NO preset assignments at all, the matrix has not
        // been set up for them yet - fall back to the existing role gate
        // (CAN_WRITE_ROLES already passed above) instead of denying. This keeps
        // live admins working; the matrix only TIGHTENS once they are given any
        // grant/assignment. grand_master/master already bypassed; officers were
        // already blocked by the rank floor above, so this cannot lift them.
        // Count this user's configuration. Errors here (e.g. the C3 tables
        // staff_area_grants / preset_assignments not yet applied) DEGRADE TO
        // fail-open via the role gate, never a lockout - the role gate
        // (CAN_WRITE_ROLES) has already qualified the actor. Ordering-safe: if
        // 982 goes live before migration 0260, admins keep working.
        let grantCount = 0, assignCount = 0, countOk = true;
        try {
          const gRes = await admin.from('staff_area_grants').select('id', {
            count: 'exact',
            head: true
          }).eq('user_id', actorId).eq('status', 'active');
          const aRes = await admin.from('preset_assignments').select('id', {
            count: 'exact',
            head: true
          }).eq('user_id', actorId).eq('status', 'active');
          if (gRes.error || aRes.error) {
            countOk = false;
            console.warn('[bob-upsert-generic] grant/assignment count unavailable; fail-open:', gRes.error?.message ?? aRes.error?.message);
          }
          grantCount = gRes.count ?? 0;
          assignCount = aRes.count ?? 0;
        } catch (e) {
          countOk = false;
          console.warn('[bob-upsert-generic] grant/assignment count threw; fail-open:', e);
        }
        if (!countOk || grantCount === 0 && assignCount === 0) {
          // Unconfigured (or tables not yet present) => fail-open via role gate.
          console.log(`[bob-upsert-generic] access matrix unconfigured for ${actorId} (${actorRole}); fail-open for area '${area}'.`);
        } else {
          // Configured: enforce area x level.
          const targetOrg = String(data.organization_id ?? '') || null;
          const needed = writeLevelForTable(table);
          try {
            const { data: grants } = await admin.rpc('resolve_access_grants', {
              p_user_id: actorId,
              p_org_id: targetOrg
            });
            const row = Array.isArray(grants) ? grants.find((g)=>g.area === area) : null;
            const have = row ? String(row.level) : undefined;
            if (!levelAtLeast(have, needed)) {
              return json({
                error: `Forbidden: writing '${table}' needs ${area}:${needed}; you have ${area}:${have ?? 'none'}.`,
                area,
                needed,
                have: have ?? null,
                area_permission_denied: true
              }, 403);
            }
          } catch (e) {
            // The user IS configured but the resolver failed - deny (safe).
            console.error('[bob-upsert-generic] resolve_access_grants failed for configured user:', e);
            return json({
              error: 'Access check failed; write denied.',
              area
            }, 403);
          }
        }
      }
    }
    // Load live schema + map fields. Table existence is proven by the live schema
    // itself: no rows => the table does not exist in the public schema. This is
    // how Bob has free access to the whole build without a hardcoded allowlist.
    const cols = await loadColumns(admin, table);
    if (!cols.length) return json({
      error: `Table '${table}' was not found in the live public schema. Check the name via schema inspect.`,
      unknown_table: true
    }, 404);
    const { mapped, dropped } = mapFields(data, cols);
    // Determine required-but-missing (DB NOT NULL w/o default + business-required),
    // excluding guarded + auto columns. Turn these into clarifying questions.
    if (mode === 'create') {
      const dbRequired = cols.filter((c)=>!c.nullable && !c.default && !GUARDED_COLUMNS.has(c.name)).map((c)=>c.name);
      const required = [
        ...new Set([
          ...BUSINESS_REQUIRED[table] ?? [],
          ...dbRequired
        ])
      ];
      const missing = required.filter((r)=>mapped[r] === undefined || mapped[r] === null || mapped[r] === '');
      if (missing.length) {
        return json({
          success: false,
          needs_clarification: true,
          table,
          mode,
          missing_required: missing,
          clarifying_questions: missing.map((m)=>`What is the ${m.replace(/_/g, ' ')} for this ${table.replace(/s$/, '')}?`),
          mapped_columns: Object.keys(mapped),
          dropped_fields: dropped
        }, 200);
      }
    }
    // Dedupe on create.
    if (mode === 'create') {
      const hints = DEDUPE_HINTS[table] ?? [];
      for (const keyset of hints){
        if (keyset.every((k)=>mapped[k] !== undefined && mapped[k] !== null && mapped[k] !== '')) {
          let q = admin.from(table).select('id');
          for (const k of keyset)q = q.eq(k, mapped[k]);
          const { data: dup } = await q.maybeSingle();
          if (dup) return json({
            success: false,
            blocked: 'duplicate',
            existing: dup,
            matched_on: keyset,
            note: `Likely duplicate in ${table}. Use mode=update with target_id.`
          }, 409);
        }
      }
    }
    if (dryRun) {
      return json({
        success: true,
        dry_run: true,
        table,
        mode,
        planned_row: mapped,
        mapped_columns: Object.keys(mapped),
        dropped_fields: dropped,
        target_id: mode === 'update' ? body.target_id ?? null : undefined,
        provenance,
        note: 'Dry-run only. No write performed. Review mapped columns and dropped fields.'
      });
    }
    if (mode === 'update' && !body.target_id) return json({
      error: 'target_id required for update'
    }, 400);
    let result;
    let error;
    if (mode === 'create') {
      ({ data: result, error } = await admin.from(table).insert(mapped).select('id').single());
    } else {
      ({ data: result, error } = await admin.from(table).update(mapped).eq('id', body.target_id).select('id').single());
    }
    if (error) return json({
      error: error.message,
      table,
      dropped_fields: dropped
    }, 500);
    return json({
      success: true,
      table,
      mode,
      result_table: table,
      result_record_id: result.id,
      mapped_columns: Object.keys(mapped),
      dropped_fields: dropped,
      provenance,
      audit: {
        actor_id: actorId,
        actor_role: actorRole
      }
    });
  } catch (err) {
    console.error('[bob-upsert-generic] error:', err);
    return json({
      error: 'Upsert failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
