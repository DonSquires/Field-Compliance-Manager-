/**
 * generate-parking-notice — Parking infringement notice generation
 *
 * POST /functions/v1/generate-parking-notice
 * Body: { chalk_record_id, officer_name, authorized_by, additional_notes, infringement_fee }
 *
 * Mirrors generate-notice's PDF/receipt-building shape but targets
 * parking_chalk_records -> parking_infringement_notices (a schema that
 * already existed with the right lifecycle/evidence columns but had no
 * generator anywhere in the codebase before this).
 *
 * Uses the org's active notice_templates row scoped to
 * module_key='parking_enforcement', notice_type='infringement' when one
 * exists; otherwise requires infringement_fee explicitly rather than
 * inventing a legal amount.
 *
 * Legal boundary: this only generates a draft. No notice is formally issued
 * until an authorised officer/admin reviews and confirms it.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { embedPdfNotoFonts } from '../_shared/pdf-noto-fonts.ts';
import { pdfTextFontRuns, wrapPdfText } from '../_shared/pdf-text-fonts.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const PDF_RENDERER_VERSION = 'fcm-parking-notice-pdf-lib-a4-v5';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function htmlToLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?><\/p>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|li|tr|footer)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function buildPdfBytes(html: string, title: string, noticeNumber: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { normal, bold } = await embedPdfNotoFonts(pdf);
  pdf.setTitle(title);
  pdf.setSubject(`Parking notice ${noticeNumber}`);
  pdf.setCreator('Field Compliance Manager');
  const lines = htmlToLines(html);
  let page = pdf.addPage([595, 842]);
  let y = 780;
  const draw = (text: string, fonts = normal, size = 10) => {
    for (const line of wrapPdfText(text, fonts, size, 487)) {
      if (y < 64) { page = pdf.addPage([595, 842]); y = 780; }
      let x = 54;
      for (const run of pdfTextFontRuns(line, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.08, 0.08, 0.08) });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      y -= size + 6;
    }
  };
  draw(title, bold, 17);
  draw(`Notice number: ${noticeNumber}`, normal, 9);
  draw(`Generated ${new Date().toISOString()}`, normal, 9);
  page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 541, y: y + 2 }, thickness: 1.5, color: rgb(0.18, 0.18, 0.18) });
  y -= 14;
  for (const line of lines) draw(line);
  draw('This PDF is a generated notice artifact. The notice remains subject to the recorded signature and issue workflow.', normal, 8);
  return pdf.save();
}

function noticeHtml(d: {
  orgName: string; noticeNumber: string; plate: string; zoneName: string; officerName: string;
  authorizedBy: string; noticeDate: string; fineAmount: number; legislativeText: string; dueDate: string; additionalNotes: string;
}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Parking Infringement Notice - ${d.noticeNumber}</title></head>
<body style="font-family:Arial,sans-serif;color:#111;max-width:640px;margin:24px auto;">
<h1 style="margin:0 0 6px;">PARKING INFRINGEMENT NOTICE</h1>
<p style="color:#555;font-size:13px;">${escapeHtml(d.orgName)}</p>
<hr/>
<p><strong>Notice number:</strong> ${escapeHtml(d.noticeNumber)}</p>
<p><strong>Date issued:</strong> ${escapeHtml(d.noticeDate)}</p>
<p><strong>Vehicle plate:</strong> ${escapeHtml(d.plate)}</p>
<p><strong>Location:</strong> ${escapeHtml(d.zoneName)}</p>
<p><strong>Amount:</strong> $${d.fineAmount.toFixed(2)}</p>
<p><strong>Payment due:</strong> ${escapeHtml(d.dueDate)}</p>
<p><strong>Legislative basis:</strong> ${escapeHtml(d.legislativeText)}</p>
${d.additionalNotes ? `<p><strong>Notes:</strong> ${escapeHtml(d.additionalNotes)}</p>` : ''}
<hr/>
<p><strong>Issuing officer:</strong> ${escapeHtml(d.officerName)}</p>
<p><strong>Authorised by:</strong> ${escapeHtml(d.authorizedBy)}</p>
<p style="font-size:11px;color:#777;">This is a draft notice. It is not formally issued until reviewed, signed, and confirmed by an authorised officer.</p>
</body></html>`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();
    const { chalk_record_id, officer_name, authorized_by, additional_notes, infringement_fee, legislative_text } = body;
    if (!chalk_record_id) return json({ error: 'chalk_record_id is required' }, 400);

    const { data: chalk, error: chalkErr } = await supabase
      .from('parking_chalk_records')
      .select('id, organization_id, plate, location_name, zone_id, client_site_id, chalked_at, photo_url, status')
      .eq('id', chalk_record_id)
      .single();
    if (chalkErr || !chalk) return json({ error: 'Chalk record not found' }, 404);

    const { data: profile } = await supabase.from('user_profiles').select('role, organization_id').eq('id', user.id).single();
    if (!profile || !['grand_master', 'master', 'admin', 'admin_officer', 'officer'].includes(String(profile.role))) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (String(profile.role) !== 'grand_master' && profile.organization_id !== chalk.organization_id) {
      return json({ error: 'Forbidden: chalk record belongs to another organization' }, 403);
    }

    const { data: org } = await supabase.from('organizations').select('name').eq('id', chalk.organization_id).single();
    const { data: template } = await supabase
      .from('notice_templates')
      .select('*')
      .eq('organization_id', chalk.organization_id)
      .eq('module_key', 'parking_enforcement')
      .eq('notice_type', 'infringement')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const fineAmount = infringement_fee ?? template?.fine_amount ?? null;
    if (fineAmount == null) {
      return json({ error: 'infringement_fee is required (no active parking_enforcement template sets a default fine_amount for this organization)' }, 400);
    }
    const legislativeText = legislative_text ?? template?.bylaw_reference ?? template?.authorising_act ?? null;
    if (!legislativeText) {
      return json({ error: 'legislative_text is required (no active parking_enforcement template sets a default bylaw reference)' }, 400);
    }

    const { data: noticeNumber, error: numberError } = await supabase.rpc('reserve_infringement_notice_number', {
      p_organization_id: chalk.organization_id,
      p_module_key: 'parking_enforcement',
      p_prefix: 'PK',
    });
    if (numberError || !noticeNumber) return json({ error: numberError?.message ?? 'Notice number could not be reserved' }, 409);

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (template?.payment_deadline_days ?? 28));
    const orgName = org?.name ?? 'Field Compliance Manager';
    const noticeDate = new Date().toLocaleDateString('en-NZ', { dateStyle: 'long', timeZone: 'Pacific/Auckland' });

    const html = noticeHtml({
      orgName,
      noticeNumber,
      plate: chalk.plate,
      zoneName: chalk.location_name ?? 'Unknown location',
      officerName: officer_name ?? 'Authorised Officer',
      authorizedBy: authorized_by ?? officer_name ?? 'Authorised Officer',
      noticeDate,
      fineAmount,
      legislativeText,
      dueDate: dueDate.toLocaleDateString('en-NZ', { dateStyle: 'long', timeZone: 'Pacific/Auckland' }),
      additionalNotes: additional_notes ?? '',
    });

    const { data: noticeRecord, error: noticeErr } = await supabase
      .from('parking_infringement_notices')
      .insert({
        organization_id: chalk.organization_id,
        chalk_record_id: chalk.id,
        notice_number: noticeNumber,
        plate_number: chalk.plate,
        zone_name: chalk.location_name,
        zone_id: chalk.zone_id,
        client_site_id: chalk.client_site_id,
        offence_description: additional_notes ?? null,
        amount: fineAmount,
        status: 'draft',
        officer_name: officer_name ?? null,
        evidence_photo_urls: chalk.photo_url ? [chalk.photo_url] : null,
        legislative_text: legislativeText,
      })
      .select('id')
      .single();
    if (noticeErr) return json({ error: noticeErr.message }, 500);

    const pdfBytes = await buildPdfBytes(html, `${orgName} — Parking Infringement Notice`, noticeNumber);
    const pdfPath = `org/${chalk.organization_id}/notices/parking/${noticeRecord.id}.pdf`;
    const { error: uploadErr } = await supabase.storage.from('notice-artifacts').upload(pdfPath, new Blob([Uint8Array.from(pdfBytes).buffer], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: true });
    let pdfUrl: string | null = null;
    if (!uploadErr) {
      pdfUrl = pdfPath;
    }

    return json({
      ok: true,
      html,
      notice_id: noticeRecord.id,
      pdf_url: pdfUrl,
      pdf_renderer_version: PDF_RENDERER_VERSION,
      receipt: {
        orgName,
        noticeType: 'infringement',
        noticeNumber,
        issuedAtIso: new Date().toISOString(),
        subjectLabel: 'Plate',
        subjectValue: chalk.plate,
        locationLabel: chalk.location_name ?? 'Unknown location',
        officerName: officer_name ?? 'Authorised Officer',
        legalBasis: legislativeText,
        fineAmount,
        dueDateIso: dueDate.toISOString(),
        notes: additional_notes ?? null,
        footerText: template?.footer_text ?? null,
      },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
