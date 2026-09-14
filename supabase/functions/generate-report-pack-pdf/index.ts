/**
 * generate-report-pack-pdf -- render one generated monthly report pack to a
 * private PDF artifact for provider and agreement-authorized client access.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const rendererVersion = 'fcm-report-pack-pdf-lib-a4-v1';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((value) => value.toString(16).padStart(2, '0')).join('');

function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, `${prefix}[${index + 1}]`));
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  return [`${prefix.replace(/_/g, ' ')}: ${String(value)}`];
}

async function renderPdf(title: string, period: string, packId: string, snapshotGeneratedAt: string | null, data: unknown): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 780;
  const draw = (text: string, font = normal, size = 10) => {
    if (y < 64) { page = pdf.addPage([595, 842]); y = 780; }
    page.drawText(text.slice(0, 115), { x: 54, y, size, font, color: rgb(0.08, 0.12, 0.13) });
    y -= size + 6;
  };
  draw('Field Compliance Manager', bold, 15);
  draw(title, bold, 18);
  draw(`Reporting period: ${period}`, normal, 10);
  draw(`Report pack ID: ${packId}`, normal, 9);
  draw(`Source snapshot generated: ${snapshotGeneratedAt ?? 'Not recorded'}`, normal, 9);
  draw(`PDF rendered: ${new Date().toISOString()}`, normal, 9);
  draw(`Renderer: ${rendererVersion}`, normal, 8);
  draw('Scope: governed aggregate snapshot; use the source records and evidence exports for detailed reconstruction.', normal, 8);
  page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 541, y: y + 2 }, thickness: 1.5, color: rgb(0.18, 0.49, 0.45) });
  y -= 14;
  for (const line of flatten(data)) draw(line);
  draw('This report is generated from the governed FCM report-pack snapshot.', normal, 8);
  draw('Source records and delivery status remain available in the client portal.', normal, 8);
  return pdf.save();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authorization = req.headers.get('Authorization') ?? '';
    if (!authorization) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const admin = createClient(url, serviceKey);
    const { data: profile } = await admin.from('user_profiles').select('role,organization_id').eq('id', user.id).single();
    if (!profile || !['grand_master', 'master', 'admin'].includes(String(profile.role))) return json({ error: 'Provider administrator required' }, 403);
    const body = await req.json().catch(() => ({}));
    const packId = String(body.pack_id ?? '').trim();
    if (!packId) return json({ error: 'pack_id is required' }, 400);
    const { data: pack, error: packError } = await admin.from('monthly_report_packs').select('id,organization_id,period_start,period_end,template_code,status,data,generated_at').eq('id', packId).single();
    if (packError || !pack) return json({ error: 'Report pack not found' }, 404);
    if (String(profile.role) !== 'grand_master' && pack.organization_id !== profile.organization_id) return json({ error: 'Forbidden' }, 403);
    if (!['generated', 'sent'].includes(pack.status)) return json({ error: 'Only generated report packs can be rendered' }, 409);
    const bytes = await renderPdf(`${pack.template_code.replace(/_/g, ' ')} report pack`, `${pack.period_start} to ${pack.period_end}`, pack.id, pack.generated_at, pack.data ?? {});
    const checksum = await sha256(bytes);
    const path = `org/${pack.organization_id}/report-packs/${pack.id}.pdf`;
    const { error: uploadError } = await admin.storage.from('bob-uploads').upload(path, new Blob([bytes], { type: 'application/pdf' }), { upsert: true, contentType: 'application/pdf' });
    if (uploadError) return json({ error: uploadError.message }, 502);
    const { data: updated, error: updateError } = await admin.from('monthly_report_packs').update({ pdf_path: path, pdf_mime_type: 'application/pdf', pdf_sha256: checksum, pdf_renderer_version: rendererVersion, updated_at: new Date().toISOString() }).eq('id', pack.id).select('id,pdf_path,pdf_mime_type,pdf_sha256,pdf_renderer_version').single();
    if (updateError || !updated) return json({ error: updateError?.message ?? 'Report pack metadata could not be updated' }, 500);
    await admin.from('audit_log').insert({ organization_id: pack.organization_id, actor_user_id: user.id, action: 'monthly_report_pack_pdf_generated', target_table: 'monthly_report_packs', target_id: pack.id, metadata: { pdf_path: path, pdf_sha256: checksum, renderer_version: rendererVersion } });
    return json({ ok: true, pack: updated });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Report pack PDF generation failed' }, 500);
  }
});
