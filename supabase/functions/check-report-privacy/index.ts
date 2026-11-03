/**
 * check-report-privacy -- Bob's privacy oracle for a monthly client report.
 * Bob reads every client-facing entry in the pack's frozen activity and the
 * reviewer's wording (title, executive summary, notes, follow-up) and points
 * out the words that identify a private individual; the pack's copy is
 * reworded with "[name withheld]" so the PDF, the email and the client portal
 * can never show them. The source records are not changed. Long months are
 * checked across several calls: the response says how many entries remain.
 *
 * With an editorial object in the body (the review panel publishing), that
 * wording is checked and returned reworded instead of being stored, so the
 * panel publishes the checked wording. The PDF and the email refuse a pack
 * whose current wording has not been cleared by this check.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { completeWithProviders } from '../_shared/report-executive-summary.mjs';
import {
  EDITORIAL_TEXT_FIELDS,
  PRIVACY_BATCH_SIZE,
  PRIVACY_VERSION,
  applyPrivacyFindings,
  editorialDigest,
  editorialText,
  parsePrivacyFindings,
  privacyBatchMessage,
  privacyCandidates,
  privacyStatus,
  privacySystemPrompt,
  protectedTerms,
  withholdFindings,
} from '../_shared/report-privacy-oracle.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const canCheck = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
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

type Named = { name?: string | null } | Array<{ name?: string | null }> | null | undefined;
const relationName = (value: Named) => {
  const name = Array.isArray(value) ? value[0]?.name : value?.name;
  return typeof name === 'string' ? name.trim() : '';
};
type Findings = { names: string[]; details: string[] };
type Candidate = ReturnType<typeof privacyCandidates>[number];
const isDocument = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).lines));

async function handleCheck(req: Request) {
  const started = Date.now();
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const packId = typeof body.pack_id === 'string' ? body.pack_id.trim() : '';
  if (!packId) throw new RequestError('pack_id is required', 400);
  const proposed = body.editorial && typeof body.editorial === 'object' && !Array.isArray(body.editorial) ? body.editorial as Record<string, unknown> : null;

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) throw new RequestError('Unauthorized', 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) throw new RequestError('Unauthorized', 401);
  const admin = createClient(url, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('role,deactivated_at').eq('id', user.id).single();
  if (!profile || profile.deactivated_at || !canCheck.has(String(profile.role))) throw new RequestError('Provider administrator required', 403);

  const { data: pack, error: packError } = await admin.from('monthly_report_packs')
    .select('id,organization_id,status,report_kind,activity_lines,editorial,updated_at,agreement:service_agreement_id(name,client:client_organization_id(name)),provider:organization_id(name)')
    .eq('id', packId).single();
  if (packError || !pack) throw new RequestError('Report pack not found', 404);
  const { data: mayCheck } = await caller.rpc('is_report_provider_custodian_for_org', { p_target_organization_id: pack.organization_id });
  if (mayCheck !== true) throw new RequestError('Forbidden', 403);
  if (!['draft', 'generated'].includes(pack.status)) throw new RequestError('Sent report packs cannot be changed', 409);

  const agreement = Array.isArray(pack.agreement) ? pack.agreement[0] : pack.agreement;
  const terms = protectedTerms(pack.activity_lines, [relationName(agreement?.client), relationName(agreement), relationName(pack.provider)]);
  const system = privacySystemPrompt(terms);
  const env = Object.fromEntries(MODEL_ENV.map((key) => [key, Deno.env.get(key)]));
  const models = new Set<string>();
  const ask = async (batch: Array<{ fields: Record<string, string> }>) => {
    const outcome = await completeWithProviders({
      messages: [{ role: 'system', content: system }, { role: 'user', content: privacyBatchMessage(batch) }],
      env,
      timeoutMs: BATCH_TIMEOUT_MS,
      failurePrefix: 'Bob could not complete the privacy check',
      accept: (content: unknown) => parsePrivacyFindings(content, batch.length),
    });
    models.add(`${outcome.provider}:${outcome.model}`);
    return outcome.value as Map<number, Findings>;
  };

  // The reviewer's wording first: one short call, and it must clear for the report to go out.
  const editorialSource = editorialText(proposed ?? pack.editorial);
  const stored = isDocument(pack.activity_lines) ? (pack.activity_lines.privacy as Record<string, unknown> | undefined) : undefined;
  let editorial = editorialSource;
  let editorialReworded = 0;
  const editorialFields = EDITORIAL_TEXT_FIELDS.filter((field) => editorialSource[field]);
  if (editorialFields.length && (proposed || stored?.editorial_digest !== editorialDigest(editorialSource))) {
    const findings = await ask(editorialFields.map((field) => ({ fields: { text: editorialSource[field] } }))).catch((error) => {
      throw new RequestError(error instanceof Error ? error.message : 'Bob could not check the review wording', 502);
    });
    editorial = { ...editorialSource };
    editorialFields.forEach((field, index) => {
      const found = findings.get(index);
      if (!found) return;
      const updated = withholdFindings(editorialSource[field], found, terms);
      if (updated !== editorialSource[field]) {
        editorial[field] = updated;
        editorialReworded += 1;
      }
    });
  }

  const candidates = privacyCandidates(pack.activity_lines);
  const batches: Candidate[][] = [];
  for (let index = 0; index < candidates.length; index += PRIVACY_BATCH_SIZE) batches.push(candidates.slice(index, index + PRIVACY_BATCH_SIZE));
  const checked: Array<{ indexes: number[]; findings: Findings | null }> = [];
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length && Date.now() - started < START_BUDGET_MS) {
      const batch = batches[next];
      next += 1;
      try {
        const findings = await ask(batch);
        batch.forEach((candidate, index) => checked.push({ indexes: candidate.indexes, findings: findings.get(index) ?? null }));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const applied = applyPrivacyFindings(pack.activity_lines, checked, terms);
  const digest = editorialDigest(editorial);
  const writeEditorial = !proposed && editorialReworded > 0;
  const changed = checked.length > 0 || writeEditorial || (isDocument(pack.activity_lines) && stored?.editorial_digest !== digest);
  let updatedAt = pack.updated_at as string;
  if (changed && isDocument(applied.activityLines)) {
    const nextLines = {
      ...applied.activityLines,
      privacy: { version: PRIVACY_VERSION, checked_at: new Date().toISOString(), editorial_digest: digest, models: [...models] },
    };
    const editorialRecord = pack.editorial && typeof pack.editorial === 'object' ? pack.editorial as Record<string, unknown> : {};
    const update: Record<string, unknown> = { activity_lines: nextLines, updated_at: new Date().toISOString() };
    if (writeEditorial) {
      update.editorial = { ...editorialRecord, ...Object.fromEntries(EDITORIAL_TEXT_FIELDS.filter((field) => editorial[field]).map((field) => [field, editorial[field]])) };
    }
    const { data: saved, error: saveError } = await admin.from('monthly_report_packs')
      .update(update)
      .eq('id', pack.id)
      .in('status', ['draft', 'generated'])
      .eq('updated_at', pack.updated_at)
      .select('updated_at');
    if (saveError) throw new RequestError(`Privacy check could not be saved: ${saveError.message}`, 500);
    if ((saved ?? []).length !== 1) throw new RequestError('Report pack changed during the privacy check; run it again', 409);
    updatedAt = String(saved![0].updated_at);
  }

  const status = privacyStatus(isDocument(applied.activityLines) ? { ...applied.activityLines, privacy: { editorial_digest: digest } } : applied.activityLines, editorial);
  const remaining = status.pendingLines;
  const { error: auditError } = await admin.from('audit_log').insert({
    organization_id: pack.organization_id,
    actor_user_id: user.id,
    action: 'report_privacy_checked',
    target_table: 'monthly_report_packs',
    target_id: pack.id,
    metadata: {
      entries_checked: checked.reduce((sum, item) => sum + item.indexes.length, 0),
      entries_reworded: applied.reworded,
      editorial_fields_reworded: editorialReworded,
      editorial_returned: Boolean(proposed),
      remaining,
      failed_batches: failures.length,
      models: [...models],
    },
  });
  if (auditError) throw new RequestError(`Privacy check ran but audit receipt failed: ${auditError.message}`, 502);
  if (checked.length === 0 && candidates.length > 0 && failures.length > 0) throw new RequestError(failures[0] ?? 'Bob could not complete the privacy check', 502);

  return json({
    ok: true,
    checked: checked.reduce((sum, item) => sum + item.indexes.length, 0),
    reworded: applied.reworded,
    editorial_reworded: editorialReworded,
    remaining,
    cleared: remaining === 0,
    updated_at: updatedAt,
    ...(proposed ? { editorial } : {}),
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handleCheck(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Privacy check failed' }, 500);
  }
});
