/**
 * bob-propose-compliance-record — governed producer for an organisation's
 * compliance register (organization_compliance_records): H&S policies, H&S
 * plans, contractor prequalification, licences, insurance, registrations,
 * certifications.
 *
 * POST /functions/v1/bob-propose-compliance-record
 * Body: {
 *   organization_id,            // EXPLICIT id resolved with query_records first
 *   records: [{                 // 1..12 records; one pending action each
 *     record_type,              // company_licence | insurance | policy |
 *                               // prequalification | registration | certification | other
 *     name, source_name, source_as_of,
 *     issuer?, reference_number?, effective_date?, expiry_date?,
 *     coverage_amount?, currency?, source_notes?,
 *     evidence_document_id?, source_attachment_id?, replaces_record_id?
 *   }],
 *   reasoning?, conversation_id?, context_summary?
 * }
 *
 * Bob is the PROPOSER only. A master approves each action; the service-only
 * apply_bob_compliance_record_proposal RPC writes it as 'unverified', and a
 * master still verifies the evidence in the organisation Compliance section.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = new Set(['grand_master', 'master', 'admin']);
const RECORD_TYPES = new Set(['company_licence', 'insurance', 'policy', 'prequalification', 'registration', 'certification', 'other']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS = 12;

type RecordInput = Record<string, unknown>;
type CleanRecord = {
  record_type: string;
  name: string;
  source_name: string;
  source_as_of: string;
  issuer: string | null;
  reference_number: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  coverage_amount: number | null;
  currency: string;
  source_notes: string | null;
  evidence_document_id: string | null;
  source_attachment_id: string | null;
  replaces_record_id: string | null;
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' }
});

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  const v = text(value, 32);
  if (!v) return null;
  const day = v.slice(0, 10);
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error(`Invalid date '${v}' (use YYYY-MM-DD)`);
  return day;
}

function optionalUuid(value: unknown, field: string): string | null {
  const v = text(value, 64);
  if (!v) return null;
  if (!UUID_RE.test(v)) throw new Error(`${field} must be a UUID`);
  return v;
}

function cleanComplianceRecord(input: RecordInput): CleanRecord {
  const recordType = String(input.record_type ?? '').trim();
  if (!RECORD_TYPES.has(recordType)) throw new Error(`record_type must be one of ${[...RECORD_TYPES].join(', ')}`);
  const name = text(input.name, 200);
  if (!name || name.length < 2) throw new Error('Each record needs a name (2-200 characters)');
  const sourceName = text(input.source_name, 500);
  if (!sourceName || sourceName.length < 2) throw new Error(`'${name}' needs source_name (the document or source it came from)`);
  const sourceAsOf = isoDate(input.source_as_of);
  if (!sourceAsOf) throw new Error(`'${name}' needs source_as_of (the date of the source document, YYYY-MM-DD)`);
  const effective = isoDate(input.effective_date);
  const expiry = isoDate(input.expiry_date);
  if (effective && expiry && expiry < effective) throw new Error(`'${name}' expiry_date cannot precede effective_date`);
  let coverage: number | null = null;
  if (input.coverage_amount !== undefined && input.coverage_amount !== null && input.coverage_amount !== '') {
    coverage = Number(input.coverage_amount);
    if (!Number.isFinite(coverage) || coverage < 0) throw new Error(`'${name}' coverage_amount must be a non-negative number`);
  }
  const currency = (text(input.currency, 3) ?? 'NZD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`'${name}' currency must be a 3-letter code`);
  return {
    record_type: recordType,
    name,
    source_name: sourceName,
    source_as_of: sourceAsOf,
    issuer: text(input.issuer, 200),
    reference_number: text(input.reference_number, 200),
    effective_date: effective,
    expiry_date: expiry,
    coverage_amount: coverage,
    currency,
    source_notes: text(input.source_notes, 4000),
    evidence_document_id: optionalUuid(input.evidence_document_id, 'evidence_document_id'),
    source_attachment_id: optionalUuid(input.source_attachment_id, 'source_attachment_id'),
    replaces_record_id: optionalUuid(input.replaces_record_id, 'replaces_record_id')
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return reply({ error: 'Unauthorized' }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return reply({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role, organization_id, deactivated_at').eq('id', caller.id).single();
    if (!profile || profile.deactivated_at || !CAN_PROPOSE.has(String(profile.role))) {
      return reply({ error: 'Forbidden: an admin, master, or grand master is required' }, 403);
    }

    const body = await req.json();
    const orgId = String(body.organization_id ?? '').trim();
    if (!UUID_RE.test(orgId)) return reply({ error: 'organization_id must be an explicit organization UUID (resolve the name with query_records first)' }, 400);
    const { data: inScope } = await callerClient.rpc('is_admin_for_org', { target_org_id: orgId });
    if (inScope !== true) return reply({ error: 'Not authorised for the specified organization_id' }, 403);
    const { data: org } = await admin.from('organizations').select('id, name').eq('id', orgId).maybeSingle();
    if (!org) return reply({ error: `organization_id ${orgId} does not exist` }, 422);

    const rawRecords: RecordInput[] = Array.isArray(body.records)
      ? body.records
      : body.record_type ? [body] : [];
    if (!rawRecords.length) return reply({ error: 'Provide at least one record in records[]' }, 400);
    if (rawRecords.length > MAX_RECORDS) return reply({ error: `At most ${MAX_RECORDS} records per proposal batch` }, 400);
    let records: CleanRecord[];
    try {
      records = rawRecords.map((r) => cleanComplianceRecord(r ?? {}));
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : 'Invalid record' }, 400);
    }

    const { data: currentRows } = await admin
      .from('organization_compliance_records')
      .select('id, record_type, name')
      .eq('organization_id', orgId)
      .eq('status', 'current');
    const current = Array.isArray(currentRows) ? currentRows : [];

    const conversationId = text(body.conversation_id, 64);
    const reasoningBase = text(body.reasoning, 2000);
    const results: Array<Record<string, unknown>> = [];
    for (const record of records) {
      if (record.replaces_record_id && !current.some((row) => row.id === record.replaces_record_id)) {
        results.push({ name: record.name, outcome: 'rejected', error: 'replaces_record_id is not a current record for this organization' });
        continue;
      }
      // A current record with the same type and name is superseded, never duplicated.
      const existing = record.replaces_record_id
        ? null
        : current.find((row) => row.record_type === record.record_type && String(row.name).trim().toLowerCase() === record.name.toLowerCase());
      const payload = {
        organization_id: orgId,
        ...record,
        replaces_record_id: record.replaces_record_id ?? existing?.id ?? null,
        triggered_by: caller.id
      };
      const idempotencyKey = `compliance_record:${await sha256Hex(JSON.stringify([orgId, record.record_type, record.name.toLowerCase(), record.source_name, record.source_as_of]))}`;
      const reasoning = [
        reasoningBase ?? `Bob proposes adding '${record.name}' (${record.record_type}) to ${org.name}'s compliance register from ${record.source_name} (${record.source_as_of}).`,
        payload.replaces_record_id ? 'Approving supersedes the current record with the same type and name.' : '',
        'The record is written as unverified; a master must still verify the evidence in the Compliance section.'
      ].filter(Boolean).join(' ');
      const { data: action, error } = await admin.from('bob_agentic_actions').insert({
        organization_id: profile.organization_id,
        user_id: BOB_USER_ID,
        triggered_by: caller.id,
        action_type: 'create_org_compliance_record',
        context_page: 'organization-compliance',
        context_table: 'organization_compliance_records',
        context_record_id: orgId,
        proposed_payload: payload,
        status: 'pending',
        bob_reasoning: reasoning,
        conversation_id: conversationId,
        context_summary: text(body.context_summary, 300) ?? `Compliance record for ${org.name}: ${record.name}`,
        idempotency_key: idempotencyKey
      }).select('id').single();
      if (error || !action) {
        if (error?.code === '23505') {
          const { data: pending } = await admin.from('bob_agentic_actions').select('id').eq('idempotency_key', idempotencyKey).eq('status', 'pending').maybeSingle();
          results.push({ name: record.name, outcome: 'already_pending', action_id: pending?.id ?? null });
          continue;
        }
        results.push({ name: record.name, outcome: 'failed', error: error?.message ?? 'Could not create proposal' });
        continue;
      }
      results.push({ name: record.name, record_type: record.record_type, outcome: 'pending', action_id: action.id, supersedes: payload.replaces_record_id });
    }

    const filed = results.filter((r) => r.outcome === 'pending' || r.outcome === 'already_pending');
    return reply({
      success: filed.length > 0,
      organization_id: orgId,
      organization_name: org.name,
      results,
      action_ids: filed.map((r) => r.action_id).filter(Boolean),
      note: filed.length
        ? `Filed ${filed.length} compliance-register proposal${filed.length === 1 ? '' : 's'} for ${org.name}. Nothing is written until a master approves each one in the bell; approved records stay unverified until a master verifies the evidence.`
        : `No compliance-register proposals were filed for ${org.name}.`
    }, filed.length ? 200 : 422);
  } catch (err) {
    return reply({ error: 'Server error', details: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});
