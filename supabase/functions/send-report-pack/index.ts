/**
 * send-report-pack — email a generated monthly report pack via SMTP
 *
 * POST /functions/v1/send-report-pack
 * Body: { pack_id, to }  (`to`, when supplied, must match the active primary client contact)
 *
 * Auth: valid JWT from an admin/master/grand_master user in the pack's org.
 *
 * Sends a plain summary email of the pack via the configured SMTP, then
 * updates monthly_report_packs delivery log (status='sent', sent_at, sent_to)
 * or records delivery_error on failure.
 *
 * Required edge-function secrets (set in Supabase → Edge Functions → Secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * If any are missing the function returns a clear 'SMTP not configured'
 * error and writes delivery_error — it never silently succeeds.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { activityEmailSummary } from '../_shared/report-activity-sections.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '587');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? SMTP_USER;
const CURRENT_REPORT_PDF_RENDERER = 'fcm-report-pack-pdf-lib-a4-v12';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_SEND = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);

type JsonMap = Record<string, unknown>;
type SupabaseClient = ReturnType<typeof createClient<any>>;

interface ReportPackEmail {
  id: string;
  organization_id: string;
  service_agreement_id: string;
  period_start: string;
  period_end: string;
  status: string;
  published_at: string | null;
  delivery_channel: string | null;
  report_kind: string;
  report_scope: JsonMap;
  data: JsonMap | null;
  editorial: JsonMap | null;
  pdf_path: string | null;
  pdf_renderer_version: string | null;
  pdf_source_updated_at: string | null;
  updated_at: string;
  sent_to: string | null;
}

function objectValue(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : null;
}

function escapeHtml(value: unknown) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = value.toString();
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function customScopeLabel(reportScope: JsonMap, key: string, valueKey: string, fallback: string) {
  const values = objectValue(reportScope.labels)?.[key];
  if (!Array.isArray(values)) return fallback;
  const labels = values.map((value)=>objectValue(value)?.[valueKey]).filter((value): value is string => typeof value === 'string' && Boolean(value));
  return labels.length ? labels.join(', ') : fallback;
}

function editorialHtml(editorial: JsonMap) {
  const sections: Array<[string, unknown]> = [
    ['Executive summary', editorial.executive_summary],
    ['Notes', editorial.client_notes],
    ['Follow-up', editorial.follow_up]
  ];
  return sections.flatMap(([heading, value])=>typeof value === 'string' && value ? [`<h3>${heading}</h3><p>${escapeHtml(value)}</p>`] : []).join('');
}

function customSummaryHtml(pack: ReportPackEmail, pdfLink: string) {
  const d = pack.data ?? {};
  const editorial = pack.editorial ?? {};
  const summary = objectValue(d.summary);
  const siteCount = Array.isArray(pack.report_scope?.site_ids) ? pack.report_scope.site_ids.length : 0;
  const zoneCount = Array.isArray(pack.report_scope?.zone_ids) ? pack.report_scope.zone_ids.length : 0;
  const hasPlaceSelection = siteCount + zoneCount > 0;
  const emptySiteLabel = hasPlaceSelection ? 'None selected' : 'All agreement Sites';
  const emptyZoneLabel = hasPlaceSelection ? 'None selected' : 'All agreement Zones';
  const summaryBlock = summary
    ? `<h3>Source snapshot</h3><p>Observations: ${escapeHtml(summary.observation_count ?? 0)} · Compliant: ${escapeHtml(summary.compliant_count ?? 0)} · Non-compliant: ${escapeHtml(summary.non_compliant_count ?? 0)} · Linked breaches: ${escapeHtml(summary.breach_count ?? 0)}</p>`
    : '';
  return `
    <h2>${escapeHtml(editorial.title || 'Custom Report')}</h2>
    <p>Period: ${escapeHtml(pack.period_start)} to ${escapeHtml(pack.period_end)}</p>
    ${editorialHtml(editorial)}
    <h3>Frozen report scope</h3>
    <p><strong>Sites:</strong> ${escapeHtml(customScopeLabel(pack.report_scope, 'sites', 'name', emptySiteLabel))}<br>
    <strong>Zones:</strong> ${escapeHtml(customScopeLabel(pack.report_scope, 'zones', 'name', emptyZoneLabel))}<br>
    <strong>People:</strong> ${escapeHtml(customScopeLabel(pack.report_scope, 'people', 'name', 'All linked people'))}<br>
    <strong>Vehicles:</strong> ${escapeHtml(customScopeLabel(pack.report_scope, 'vehicles', 'plate', 'All linked vehicles'))}</p>
    ${summaryBlock}
    ${pdfLink}
  `;
}

function monthlySummaryHtml(pack: ReportPackEmail, pdfLink: string) {
  const d = pack.data ?? {};
  const editorial = pack.editorial ?? {};
  const facilities = Array.isArray(d.facilities)
    ? d.facilities.map(objectValue).filter((facility): facility is JsonMap => facility !== null)
    : [];
  const facRows = facilities.map((facility)=>{
    const expected = typeof facility.expected === 'number' ? facility.expected : 0;
    const completed = typeof facility.completed === 'number' ? facility.completed : 0;
    const pct = expected > 0 ? Math.round(completed / expected * 100) : 0;
    return `<tr><td>${escapeHtml(facility.siteName)}</td><td align="right">${expected}</td><td align="right">${completed}</td><td align="right">${pct}%</td></tr>`;
  }).join('');
  const activity = activityEmailSummary(d);
  // The client activity report replaces the legacy patrol line; travel,
  // hours and operational detail are never part of the client email.
  const activityHtml = activity ? `<h3>Activity at your locations</h3>
    <p>${escapeHtml(activity.headline)}</p>
    ${activity.categories.length ? `<table border="1" cellpadding="4" cellspacing="0">
      <tr><th align="left">Type of activity</th><th>Entries</th></tr>
      ${activity.categories.map(([category, entries]) => `<tr><td>${escapeHtml(category)}</td><td align="right">${escapeHtml(entries)}</td></tr>`).join('')}
    </table>` : ''}
    <p>The PDF report sets out what happened at each location, with incidents, comments and photos.</p>`
    : `<h3>Patrol &amp; Activity Summary</h3>
    <p>Patrol visits: ${escapeHtml(d.patrolVisits ?? 'Not recorded')} · Camera activations: ${escapeHtml(d.cameraActivations ?? 'Not recorded')} · Vehicle observations: ${escapeHtml(d.vehicleObservations ?? 'Not recorded')}</p>`;
  const slaCounts = [d.slaMet, d.slaBreached, d.slaRunning].map((value) => typeof value === 'number' ? value : 0);
  const slaHtml = slaCounts.some((value) => value > 0)
    ? `<h3>Service Level Performance</h3>
    <p>${escapeHtml(slaCounts[0])} met · ${escapeHtml(slaCounts[1])} breached · ${escapeHtml(slaCounts[2])} in progress</p>`
    : '';
  return `
    <h2>${escapeHtml(editorial.title || 'Monthly Report Pack')}</h2>
    <p>Period: ${escapeHtml(pack.period_start)} to ${escapeHtml(pack.period_end)}</p>
    ${editorialHtml(editorial)}
    ${activityHtml}
    ${slaHtml}
    ${facilities.length ? `<h3>Site Coverage</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <tr><th align="left">Site</th><th>Planned activities</th><th>Completed activities</th><th>Completion</th></tr>
      ${facRows}
    </table>` : ''}
    ${pdfLink}
  `;
}

function summaryHtml(pack: ReportPackEmail, pdfUrl: string) {
  const pdfLink = `<p><a href="${escapeHtml(pdfUrl)}">Download the reviewed PDF report</a> (link expires in 7 days).</p>`;
  return pack.report_kind === 'custom' ? customSummaryHtml(pack, pdfLink) : monthlySummaryHtml(pack, pdfLink);
}

const json = (body: unknown, status = 200)=>new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' }
});

class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function loadDeliveryContext(req: Request, packId: string) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) throw new RequestError('Unauthorized', 401);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, deactivated_at').eq('id', caller.id).single();
  if (!callerProfile || callerProfile.deactivated_at || !CAN_SEND.has(callerProfile.role)) throw new RequestError('Forbidden: insufficient role', 403);
  const { data: pack } = await admin.from('monthly_report_packs').select('id, organization_id, service_agreement_id, period_start, period_end, status, published_at, delivery_channel, report_kind, report_scope, data, editorial, pdf_path, pdf_renderer_version, pdf_source_updated_at, updated_at, sent_to').eq('id', packId).single();
  if (!pack) throw new RequestError('Pack not found', 404);
  const { data: maySend } = await callerClient.rpc('is_report_provider_custodian_for_org', { p_target_organization_id: pack.organization_id });
  if (maySend !== true) throw new RequestError('Cannot send packs for other organizations', 403);
  return { admin, callerId: caller.id, pack: pack as ReportPackEmail };
}

function assertEmailDeliveryReady(pack: ReportPackEmail): asserts pack is ReportPackEmail & { published_at: string; delivery_channel: 'email'; pdf_path: string } {
  if (pack.status !== 'generated' || !pack.published_at) throw new RequestError('Review and publish this report pack before sending it', 409);
  if (pack.delivery_channel === 'portal') throw new RequestError('This client has live portal reporting. The published report is already available in their portal.', 409);
  if (pack.delivery_channel !== 'email') throw new RequestError('Report delivery channel has not been confirmed', 409);
  if (!pack.pdf_path) throw new RequestError('Generate the reviewed PDF before sending this report', 409);
  if (pack.pdf_source_updated_at !== pack.updated_at) throw new RequestError('Generate a current reviewed PDF before sending this report', 409);
  if (pack.pdf_renderer_version !== CURRENT_REPORT_PDF_RENDERER) throw new RequestError('Generate a PDF with the current report layout before sending this report', 409);
}

async function claimEmailDelivery(admin: SupabaseClient, callerId: string, packId: string, expectedUpdatedAt: string, requestedRecipient: string): Promise<{ deliveryAttemptId: string; recipient: string } | { alreadySentTo: string | null }> {
  const deliveryAttemptId = crypto.randomUUID();
  const { data, error } = await admin.rpc('claim_report_pack_email_delivery', {
    p_pack_id: packId,
    p_expected_updated_at: expectedUpdatedAt,
    p_delivery_attempt_id: deliveryAttemptId,
    p_actor_user_id: callerId,
    p_requested_recipient: requestedRecipient || null,
  });
  if (error) throw new RequestError(error.message, 409);
  const result = objectValue(data);
  if (result?.status === 'sent') return { alreadySentTo: typeof result.sent_to === 'string' ? result.sent_to : null };
  if (result?.status !== 'claimed' || typeof result.recipient !== 'string') throw new RequestError('Report delivery could not be claimed', 409);
  return { deliveryAttemptId, recipient: result.recipient };
}

async function finalizeEmailDelivery(admin: SupabaseClient, callerId: string, packId: string, deliveryAttemptId: string, outcome: 'sent' | 'failed', sentTo: string | null, deliveryError: string | null) {
  const { data, error } = await admin.rpc('finalize_report_pack_email_delivery', {
    p_pack_id: packId,
    p_delivery_attempt_id: deliveryAttemptId,
    p_outcome: outcome,
    p_sent_to: sentTo,
    p_error: deliveryError,
    p_actor_user_id: callerId,
  });
  if (error || !data) throw new RequestError(error?.message ?? 'Report delivery receipt could not be recorded', 409);
  return objectValue(data);
}

async function createReportDownloadUrl(admin: SupabaseClient, pdfPath: string) {
  const { data, error } = await admin.storage.from('bob-uploads').createSignedUrl(pdfPath, 7 * 24 * 60 * 60);
  if (error || !data?.signedUrl) throw new RequestError(error?.message ?? 'Reviewed PDF download link could not be created', 502);
  return data.signedUrl;
}

async function sendEmail(pack: ReportPackEmail, recipient: string, pdfUrl: string) {
  const client = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port: SMTP_PORT,
      tls: SMTP_PORT === 465,
      auth: { username: SMTP_USER, password: SMTP_PASS }
    }
  });
  await client.send({
    from: SMTP_FROM,
    to: recipient,
    subject: `${typeof pack.editorial?.title === 'string' && pack.editorial.title ? pack.editorial.title : 'Report Pack'} — ${pack.period_start} to ${pack.period_end}`,
    html: summaryHtml(pack, pdfUrl)
  });
  await client.close();
}

async function handleReportDelivery(req: Request) {
  const body = await req.json() as JsonMap;
  const packId = typeof body.pack_id === 'string' ? body.pack_id : '';
  if (!packId) throw new RequestError('pack_id is required', 400);
  const { admin, callerId, pack } = await loadDeliveryContext(req, packId);
  if (pack.status === 'sent') return json({ success: true, sent_to: pack.sent_to, already_sent: true });
  assertEmailDeliveryReady(pack);
  const requestedRecipient = typeof body.to === 'string' ? body.to.trim() : '';

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new RequestError('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM secrets)', 503);
  }

  const claim = await claimEmailDelivery(admin, callerId, pack.id, pack.updated_at, requestedRecipient);
  if ('alreadySentTo' in claim) return json({ success: true, sent_to: claim.alreadySentTo, already_sent: true });

  try {
    const pdfUrl = await createReportDownloadUrl(admin, pack.pdf_path);
    await sendEmail(pack, claim.recipient, pdfUrl);
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : 'SMTP send failed';
      const { error: cleanupError } = await admin.storage.from('bob-uploads').remove([pack.pdf_path]);
      await finalizeEmailDelivery(admin, callerId, pack.id, claim.deliveryAttemptId, 'failed', null, message);
      if (cleanupError) {
        await admin.from('audit_log').insert({
          organization_id: pack.organization_id,
          actor_user_id: callerId,
          action: 'monthly_report_pack_failed_delivery_pdf_cleanup_failed',
          target_table: 'monthly_report_packs',
          target_id: pack.id,
          metadata: { pdf_path: pack.pdf_path, delivery_attempt_id: claim.deliveryAttemptId, error: cleanupError.message },
        });
      }
    return json({ error: 'Send failed', details: message }, 502);
  }

  await finalizeEmailDelivery(admin, callerId, pack.id, claim.deliveryAttemptId, 'sent', claim.recipient, null);
  return json({ success: true, sent_to: claim.recipient });
}

serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handleReportDelivery(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    const message = error instanceof Error ? error.message : 'Internal error';
    return json({ error: 'Server error', details: message }, 500);
  }
});
