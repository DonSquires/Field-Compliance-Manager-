/**
 * flag-report-potential-incidents -- Bob reads a monthly client report's
 * logged activity and officer notes and highlights entries that may be
 * incidents, guided by his report_incident_triage knowledge and training cards
 * and the reviewer's recent decisions. Bob only highlights: decisions are made
 * by a provider reviewer through set_report_incident_triage. Entries already
 * decided are never re-assessed; entries Bob has assessed are skipped unless
 * rescan_before is given, when entries assessed before that time are checked
 * again. Long months are checked across several calls: the
 * response says how many entries remain.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { completeWithProviders } from '../_shared/report-executive-summary.mjs';
import {
  TRIAGE_BATCH_SIZE,
  TRIAGE_EXAMPLE_LIMIT,
  parseTriageFlags,
  triageBatchMessage,
  triageCandidates,
  triageSystemPrompt,
} from '../_shared/report-incident-triage.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const canTriage = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const MODEL_ENV = ['OLLAMA_API_TOKEN', 'OLLAMA_CLOUD_BASE_URL', 'REPORT_SUMMARY_OLLAMA_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'REPORT_SUMMARY_OPENAI_MODEL'];
const CONCURRENCY = 4;
const BATCH_TIMEOUT_MS = 55_000;
// Stop starting new batches after this so the call returns inside the edge wall-clock limit.
const START_BUDGET_MS = 70_000;

class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Candidate = ReturnType<typeof triageCandidates>[number];
type ExistingRow = { line_key: string; decision: string; bob_assessed_at: string | null };

async function handleFlag(req: Request) {
  const started = Date.now();
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const packId = typeof body.pack_id === 'string' ? body.pack_id.trim() : '';
  const rescanBefore = typeof body.rescan_before === 'string' && !Number.isNaN(Date.parse(body.rescan_before)) ? Date.parse(body.rescan_before) : null;
  const rescan = rescanBefore !== null;
  if (!packId) throw new RequestError('pack_id is required', 400);

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) throw new RequestError('Unauthorized', 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) throw new RequestError('Unauthorized', 401);
  const admin = createClient(url, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('role,deactivated_at').eq('id', user.id).single();
  if (!profile || profile.deactivated_at || !canTriage.has(String(profile.role))) throw new RequestError('Provider administrator required', 403);

  const { data: pack, error: packError } = await admin.from('monthly_report_packs')
    .select('id,organization_id,service_agreement_id,period_start,period_end,status,report_kind,data,activity_lines')
    .eq('id', packId).single();
  if (packError || !pack) throw new RequestError('Report pack not found', 404);
  const { data: mayTriage } = await caller.rpc('is_report_provider_custodian_for_org', { p_target_organization_id: pack.organization_id });
  if (mayTriage !== true) throw new RequestError('Forbidden', 403);
  if (!['draft', 'generated'].includes(pack.status)) throw new RequestError('Sent report packs cannot be changed', 409);
  if (pack.report_kind === 'custom') throw new RequestError('This report has no site activity to check', 409);

  const candidates = triageCandidates(pack.data, pack.activity_lines);
  const { data: existing, error: existingError } = await admin.from('report_incident_triage')
    .select('line_key,decision,bob_assessed_at')
    .eq('service_agreement_id', pack.service_agreement_id)
    .gte('line_date', pack.period_start)
    .lte('line_date', pack.period_end);
  if (existingError) throw new RequestError(`Incident review could not be read: ${existingError.message}`, 500);
  const existingByKey = new Map(((existing ?? []) as ExistingRow[]).map((row) => [row.line_key, row]));
  const pending = candidates.filter((candidate) => {
    const row = existingByKey.get(candidate.key);
    if (!row) return true;
    if (row.decision !== 'unreviewed') return false;
    return !row.bob_assessed_at || (rescanBefore !== null && Date.parse(row.bob_assessed_at) < rescanBefore);
  });

  const [cardsResult, examplesResult] = await Promise.all([
    admin.from('bob_knowledge_cards').select('key,title,content')
      .eq('category', 'report_incident_triage').eq('is_active', true)
      .or(`organization_id.is.null,organization_id.eq.${pack.organization_id}`)
      .order('key'),
    admin.from('report_incident_triage').select('excerpt,decision,incident_type,decision_note')
      .eq('organization_id', pack.organization_id).neq('decision', 'unreviewed')
      .order('decided_at', { ascending: false }).limit(TRIAGE_EXAMPLE_LIMIT),
  ]);
  if (cardsResult.error) throw new RequestError(`Bob's cards could not be read: ${cardsResult.error.message}`, 500);
  if (examplesResult.error) throw new RequestError(`Reviewer decisions could not be read: ${examplesResult.error.message}`, 500);
  const system = triageSystemPrompt(cardsResult.data ?? [], examplesResult.data ?? []);
  const env = Object.fromEntries(MODEL_ENV.map((key) => [key, Deno.env.get(key)]));

  const batches: Candidate[][] = [];
  for (let index = 0; index < pending.length; index += TRIAGE_BATCH_SIZE) batches.push(pending.slice(index, index + TRIAGE_BATCH_SIZE));
  let next = 0;
  let checked = 0;
  let flagged = 0;
  let failedBatches = 0;
  const failures: string[] = [];
  const models = new Set<string>();

  const runBatch = async (batch: Candidate[]) => {
    let outcome;
    try {
      outcome = await completeWithProviders({
        messages: [{ role: 'system', content: system }, { role: 'user', content: triageBatchMessage(batch) }],
        env,
        timeoutMs: BATCH_TIMEOUT_MS,
        failurePrefix: 'Bob could not check these entries',
        accept: (content: unknown) => parseTriageFlags(content, batch.length),
      });
    } catch (error) {
      failedBatches += 1;
      failures.push(error instanceof Error ? error.message : String(error));
      return;
    }
    const assessedAt = new Date().toISOString();
    const model = `${outcome.provider}:${outcome.model}`;
    models.add(model);
    const rows = batch.map((candidate, index) => {
      const flag = outcome.value.get(index);
      return {
        organization_id: pack.organization_id,
        service_agreement_id: pack.service_agreement_id,
        line_key: candidate.key,
        line_date: candidate.date,
        place: candidate.place,
        excerpt: candidate.excerpt,
        bob_flagged: Boolean(flag),
        bob_incident_type: flag?.type ?? null,
        bob_reason: flag?.reason || null,
        bob_confidence: flag?.confidence ?? null,
        bob_model: model,
        bob_assessed_at: assessedAt,
        updated_at: assessedAt,
      };
    });
    const { error } = await admin.from('report_incident_triage').upsert(rows, { onConflict: 'service_agreement_id,line_key' });
    if (error) {
      failedBatches += 1;
      failures.push(`save failed: ${error.message}`);
      return;
    }
    checked += rows.length;
    flagged += rows.filter((row) => row.bob_flagged).length;
  };

  const worker = async () => {
    while (next < batches.length && Date.now() - started < START_BUDGET_MS) {
      const batch = batches[next];
      next += 1;
      await runBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  const remaining = pending.length - checked;

  const { error: auditError } = await admin.from('audit_log').insert({
    organization_id: pack.organization_id,
    actor_user_id: user.id,
    action: 'report_potential_incidents_flagged',
    target_table: 'monthly_report_packs',
    target_id: pack.id,
    metadata: { candidates: candidates.length, pending: pending.length, checked, flagged, remaining, failed_batches: failedBatches, rescan, models: [...models] },
  });
  if (auditError) throw new RequestError(`Entries checked but audit receipt failed: ${auditError.message}`, 502);
  if (checked === 0 && pending.length > 0 && failedBatches > 0) throw new RequestError(failures[0] ?? 'Bob could not check the entries', 502);

  return json({ ok: true, candidates: candidates.length, checked, flagged, remaining, failed_batches: failedBatches, models: [...models] });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handleFlag(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Potential incident check failed' }, 500);
  }
});
