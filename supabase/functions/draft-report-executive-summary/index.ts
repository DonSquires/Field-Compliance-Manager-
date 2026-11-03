/**
 * draft-report-executive-summary -- Bob drafts the exception-based executive
 * summary for a monthly client report from the pack's frozen, client-facing
 * snapshot, the reviewer's incident triage and the figures of the two months
 * before. By default the draft is returned to the provider reviewer only.
 * With save_if_empty it is stored as an unreviewed Bob draft on a draft pack
 * that has no executive summary yet, so the provider's DRAFT preview shows it
 * (audit action monthly_report_pack_summary_draft_saved); a reviewer still
 * edits, saves and publishes it through review_monthly_report_pack.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { draftExecutiveSummary, executiveSummaryBrief } from '../_shared/report-executive-summary.mjs';
import { readPackTriage } from '../_shared/report-incident-triage-store.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const canDraft = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const MODEL_ENV = ['OLLAMA_API_TOKEN', 'OLLAMA_CLOUD_BASE_URL', 'REPORT_SUMMARY_OLLAMA_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'REPORT_SUMMARY_OPENAI_MODEL'];

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

async function handleDraft(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const packId = typeof body.pack_id === 'string' ? body.pack_id.trim() : '';
  if (!packId) throw new RequestError('pack_id is required', 400);
  const saveIfEmpty = body.save_if_empty === true;

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) throw new RequestError('Unauthorized', 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) throw new RequestError('Unauthorized', 401);
  const admin = createClient(url, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('role,deactivated_at').eq('id', user.id).single();
  if (!profile || profile.deactivated_at || !canDraft.has(String(profile.role))) throw new RequestError('Provider administrator required', 403);

  const { data: pack, error: packError } = await admin.from('monthly_report_packs')
    .select('id,organization_id,service_agreement_id,period_start,period_end,status,report_kind,data,activity_lines,editorial,updated_at,agreement:service_agreement_id(name,client:client_organization_id(name))')
    .eq('id', packId).single();
  if (packError || !pack) throw new RequestError('Report pack not found', 404);
  const { data: mayDraft } = await caller.rpc('is_report_provider_custodian_for_org', { p_target_organization_id: pack.organization_id });
  if (mayDraft !== true) throw new RequestError('Forbidden', 403);
  if (!['draft', 'generated'].includes(pack.status)) throw new RequestError('Sent report packs cannot be changed', 409);
  const editorial = pack.editorial && typeof pack.editorial === 'object' ? pack.editorial as Record<string, unknown> : {};
  const hasSummary = typeof editorial.executive_summary === 'string' && editorial.executive_summary.trim() !== '';
  if (saveIfEmpty && (pack.status !== 'draft' || hasSummary)) {
    return json({ ok: true, saved: false, skipped: hasSummary ? 'summary_exists' : 'published' });
  }

  const [triageResult, trendResult] = await Promise.all([
    readPackTriage<Record<string, unknown>>(admin, pack, 'line_key,bob_flagged,bob_incident_type,bob_reason,decision,incident_type'),
    admin.rpc('report_pack_trend_context', { p_pack_id: pack.id }),
  ]);
  if (triageResult.error) throw new RequestError(`Incident review could not be read: ${triageResult.error}`, 500);
  if (trendResult.error) throw new RequestError(`Previous months could not be read: ${trendResult.error.message}`, 500);

  const agreement = Array.isArray(pack.agreement) ? pack.agreement[0] : pack.agreement;
  const brief = pack.report_kind === 'custom' ? null : executiveSummaryBrief(pack.data, pack.activity_lines, {
    clientName: relationName(agreement?.client),
    agreementName: relationName(agreement),
    period: `${pack.period_start} to ${pack.period_end}`,
    periodStart: pack.period_start,
    triage: triageResult.data,
    trend: trendResult.data,
  });
  if (!brief) throw new RequestError('This report has no site activity to summarise', 409);

  const env = Object.fromEntries(MODEL_ENV.map((key) => [key, Deno.env.get(key)]));
  let draft: { summary: string; provider: string; model: string };
  try {
    draft = await draftExecutiveSummary({ brief, env });
  } catch (error) {
    throw new RequestError(error instanceof Error ? error.message : 'Bob could not draft the summary', 502);
  }

  let saved = false;
  if (saveIfEmpty) {
    const { data: updated, error: saveError } = await admin.from('monthly_report_packs')
      .update({
        editorial: { ...editorial, executive_summary: draft.summary.slice(0, 4000) },
        updated_at: new Date().toISOString(),
      })
      .eq('id', pack.id)
      .eq('status', 'draft')
      .eq('updated_at', pack.updated_at)
      .select('id');
    if (saveError) throw new RequestError(`Summary drafted but could not be stored: ${saveError.message}`, 500);
    saved = (updated ?? []).length === 1;
  }

  const { error: auditError } = await admin.from('audit_log').insert({
    organization_id: pack.organization_id,
    actor_user_id: user.id,
    action: saved ? 'monthly_report_pack_summary_draft_saved' : 'monthly_report_pack_summary_drafted',
    target_table: 'monthly_report_packs',
    target_id: pack.id,
    metadata: {
      saved,
      provider: draft.provider,
      model: draft.model,
      entries_sent: brief.entries.length,
      entries_not_included: brief.entriesNotIncluded,
      triage_rows: (triageResult.data ?? []).length,
      comparable_prior_months: brief.previousMonths.filter((month) => month.comparable).length,
    },
  });
  if (auditError) throw new RequestError(`Summary drafted but audit receipt failed: ${auditError.message}`, 502);
  return json({ ok: true, saved, summary: draft.summary, provider: draft.provider, model: draft.model });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handleDraft(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Executive summary drafting failed' }, 500);
  }
});
