/**
 * generate-report-pack-pdf -- render one generated monthly report pack to a
 * private PDF artifact for provider and agreement-authorized client access.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb, type PDFFont } from 'https://esm.sh/pdf-lib@1.17.1';
import * as fontkitModule from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

type PdfFontkit = Parameters<PDFDocument['registerFontkit']>[0];
const fontkit = (fontkitModule as unknown as { default: PdfFontkit }).default;

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const rendererVersion = 'fcm-report-pack-pdf-lib-a4-v4';
const fontUrls = {
  normal: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans@5.2.8/files/noto-sans-latin-ext-400-normal.woff',
  bold: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans@5.2.8/files/noto-sans-latin-ext-700-normal.woff',
};
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))).map((value) => value.toString(16).padStart(2, '0')).join('');
const canRender = new Set(['grand_master', 'master', 'admin']);

type SupabaseClient = ReturnType<typeof createClient<any>>;

interface PdfReportPack {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  template_code: string;
  status: string;
  data: Record<string, unknown> | null;
  editorial: Record<string, unknown> | null;
  generated_at: string | null;
  report_kind: string;
  report_scope: Record<string, unknown>;
  updated_at: string;
  pdf_path: string | null;
  delivery_channel: string | null;
}

class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, `${prefix}[${index + 1}]`));
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') rendered = value.toString();
  else return [];
  return [`${prefix.replaceAll('_', ' ')}: ${rendered}`];
}

function customScopeLines(reportScope: unknown): string[] {
  if (!reportScope || typeof reportScope !== 'object' || Array.isArray(reportScope)) return [];
  const scope = reportScope as Record<string, unknown>;
  const labels = scope.labels && typeof scope.labels === 'object' && !Array.isArray(scope.labels)
    ? scope.labels as Record<string, unknown>
    : {};
  const labelValues = (key: string, valueKey: 'name' | 'plate') => {
    const values = labels[key];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const label = (value as Record<string, unknown>)[valueKey];
      return typeof label === 'string' && label ? [label] : [];
    });
  };
  const sections = Array.isArray(scope.sections) ? scope.sections.filter((value): value is string => typeof value === 'string') : [];
  const hasPlaceSelection = (Array.isArray(scope.site_ids) ? scope.site_ids.length : 0) + (Array.isArray(scope.zone_ids) ? scope.zone_ids.length : 0) > 0;
  return [
    `Sites: ${labelValues('sites', 'name').join(', ') || (hasPlaceSelection ? 'None selected' : 'All agreement Sites')}`,
    `Zones: ${labelValues('zones', 'name').join(', ') || (hasPlaceSelection ? 'None selected' : 'All agreement Zones')}`,
    `People: ${labelValues('people', 'name').join(', ') || 'All linked people'}`,
    `Vehicles: ${labelValues('vehicles', 'plate').join(', ') || 'All linked vehicles'}`,
    `Sections: ${sections.join(', ') || 'None'}`,
  ];
}

function splitTokenToWidth(token: string, font: PDFFont, size: number, maxWidth: number) {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of Array.from(token)) {
    const candidate = `${chunk}${character}`;
    if (chunk && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.trim().split(/\s+/).filter(Boolean).flatMap((token) => splitTokenToWidth(token, font, size, maxWidth));
    let line = '';
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = token;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    if (!tokens.length) lines.push(' ');
  }
  return lines;
}

interface ReportRenderInput {
  templateTitle: string;
  period: string;
  packId: string;
  snapshotGeneratedAt: string | null;
  editorial: Record<string, unknown>;
  data: unknown;
  reportKind: string;
  reportScope: unknown;
  status: string;
  deliveryChannel: string | null;
}

function availabilityLine(status: string, deliveryChannel: string | null) {
  if (status === 'draft') return 'Availability: provider-private draft for review.';
  if (deliveryChannel === 'portal') return 'Availability: published in the authorized client portal.';
  if (deliveryChannel === 'email') return 'Availability: prepared for approved primary-contact email delivery.';
  return 'Availability: governed provider report record.';
}

async function renderPdf({ templateTitle, period, packId, snapshotGeneratedAt, editorial, data, reportKind, reportScope, status, deliveryChannel }: ReportRenderInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setLanguage('en-NZ');
  const [normalResponse, boldResponse] = await Promise.all([fetch(fontUrls.normal), fetch(fontUrls.bold)]);
  if (!normalResponse.ok || !boldResponse.ok) throw new Error('Unicode report fonts could not be loaded');
  const [normal, bold] = await Promise.all([
    pdf.embedFont(await normalResponse.arrayBuffer(), { subset: true }),
    pdf.embedFont(await boldResponse.arrayBuffer(), { subset: true }),
  ]);
  let page = pdf.addPage([595, 842]);
  let y = 780;
  const draw = (text: string, font = normal, size = 10) => {
    for (const line of wrapText(text, font, size, 487)) {
      if (y < 64) { page = pdf.addPage([595, 842]); y = 780; }
      page.drawText(line, { x: 54, y, size, font, color: rgb(0.08, 0.12, 0.13) });
      y -= size + 6;
    }
  };
  draw('Field Compliance Manager', bold, 15);
  draw(typeof editorial.title === 'string' && editorial.title ? editorial.title : templateTitle, bold, 18);
  draw(`Reporting period: ${period}`, normal, 10);
  draw(`Report pack ID: ${packId}`, normal, 9);
  draw(`Source snapshot generated: ${snapshotGeneratedAt ?? 'Not recorded'}`, normal, 9);
  draw(`PDF rendered: ${new Date().toISOString()}`, normal, 9);
  draw(`Renderer: ${rendererVersion}`, normal, 8);
  draw(reportKind === 'custom' ? 'Scope: governed custom snapshot.' : 'Scope: governed monthly aggregate snapshot.', normal, 8);
  page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 541, y: y + 2 }, thickness: 1.5, color: rgb(0.18, 0.49, 0.45) });
  y -= 14;
  if (reportKind === 'custom') {
    draw('Frozen report scope', bold, 12);
    for (const line of customScopeLines(reportScope)) draw(line);
    y -= 4;
  }
  if (typeof editorial.executive_summary === 'string' && editorial.executive_summary) { draw('Executive summary', bold, 12); draw(editorial.executive_summary); y -= 4; }
  if (typeof editorial.client_notes === 'string' && editorial.client_notes) { draw('Client notes', bold, 12); draw(editorial.client_notes); y -= 4; }
  if (typeof editorial.follow_up === 'string' && editorial.follow_up) { draw('Follow-up', bold, 12); draw(editorial.follow_up); y -= 4; }
  draw('Source-derived metrics', bold, 12);
  for (const line of flatten(data)) draw(line);
  draw('This report is generated from the governed FCM report-pack snapshot.', normal, 8);
  draw(availabilityLine(status, deliveryChannel), normal, 8);
  return pdf.save();
}

async function loadRenderContext(req: Request, packId: string): Promise<{ admin: SupabaseClient; userId: string; pack: PdfReportPack }> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) throw new RequestError('Unauthorized', 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) throw new RequestError('Unauthorized', 401);
  const admin = createClient(url, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('role,organization_id,deactivated_at').eq('id', user.id).single();
  if (!profile || profile.deactivated_at || !canRender.has(String(profile.role))) throw new RequestError('Provider administrator required', 403);
  const { data: pack, error: packError } = await admin.from('monthly_report_packs').select('id,organization_id,period_start,period_end,template_code,status,data,editorial,generated_at,report_kind,report_scope,updated_at,pdf_path,delivery_channel').eq('id', packId).single();
  if (packError || !pack) throw new RequestError('Report pack not found', 404);
  const { data: mayRender } = await caller.rpc('is_report_provider_custodian_for_org', { p_target_organization_id: pack.organization_id });
  if (mayRender !== true) throw new RequestError('Forbidden', 403);
  if (!['draft', 'generated'].includes(pack.status)) throw new RequestError('Only draft or published report packs can be rendered', 409);
  return { admin, userId: user.id, pack: pack as PdfReportPack };
}

async function storeRenderedPdf(admin: SupabaseClient, userId: string, pack: PdfReportPack, bytes: Uint8Array) {
  const checksum = await sha256(bytes);
  const path = `org/${pack.organization_id}/report-packs/${pack.id}/${checksum}.pdf`;
  const { error: uploadError } = await admin.storage.from('bob-uploads').upload(path, new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }), { upsert: false, contentType: 'application/pdf' });
  if (uploadError) throw new RequestError(uploadError.message, 502);

  const { data: updated, error: updateError } = await admin.rpc('record_report_pack_pdf', {
    p_pack_id: pack.id,
    p_expected_updated_at: pack.updated_at,
    p_pdf_path: path,
    p_pdf_sha256: checksum,
    p_renderer_version: rendererVersion,
    p_actor_user_id: userId,
  });
  if (updateError || !updated) {
    const { error: cleanupError } = await admin.storage.from('bob-uploads').remove([path]);
    if (cleanupError) await admin.from('audit_log').insert({ organization_id: pack.organization_id, actor_user_id: userId, action: 'monthly_report_pack_pdf_orphan_cleanup_failed', target_table: 'monthly_report_packs', target_id: pack.id, metadata: { orphan_pdf_path: path, error: cleanupError.message } });
    throw new RequestError(updateError?.message ?? 'Report changed while the PDF was rendering; reload and create a new preview', 409);
  }

  if (pack.pdf_path && pack.pdf_path !== path) {
    const { error: cleanupError } = await admin.storage.from('bob-uploads').remove([pack.pdf_path]);
    if (cleanupError) await admin.from('audit_log').insert({ organization_id: pack.organization_id, actor_user_id: userId, action: 'monthly_report_pack_pdf_cleanup_failed', target_table: 'monthly_report_packs', target_id: pack.id, metadata: { stale_pdf_path: pack.pdf_path, replacement_pdf_path: path, error: cleanupError.message } });
  }
  return updated;
}

async function handlePdfGeneration(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const packId = typeof body.pack_id === 'string' ? body.pack_id.trim() : '';
  if (!packId) throw new RequestError('pack_id is required', 400);
  const { admin, userId, pack } = await loadRenderContext(req, packId);
  const bytes = await renderPdf({
    templateTitle: `${pack.template_code.replaceAll('_', ' ')} report pack`,
    period: `${pack.period_start} to ${pack.period_end}`,
    packId: pack.id,
    snapshotGeneratedAt: pack.generated_at,
    editorial: pack.editorial ?? {},
    data: pack.data ?? {},
    reportKind: pack.report_kind ?? 'monthly',
    reportScope: pack.report_scope ?? {},
    status: pack.status,
    deliveryChannel: pack.delivery_channel,
  });
  return json({ ok: true, pack: await storeRenderedPdf(admin, userId, pack, bytes) });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handlePdfGeneration(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Report pack PDF generation failed' }, 500);
  }
});
