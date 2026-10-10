/**
 * generate-notice — Notice generation Edge Function
 *
 * Generates printable HTML notices for:
 *   - written_warning   — Written Warning
 *   - notice_to_vacate  — Notice to Vacate (FCA 2011 s.32)
 *   - infringement      — Infringement Notice (FCA 2011 s.20, $200)
 *
 * Returns HTML suitable for browser preview plus a stored PDF artifact.
 * Stores a record in the correct notice table:
 *   - notice_to_vacate  → notices_to_vacate
 *   - infringement       → infringement_notices
 *   - written_warning    → breach_alerts update only (no separate table)
 *
 * Stores the generated HTML and PDF in Supabase Storage bucket `notice-artifacts`
 * and returns the PDF storage path.
 *
 * Uses the org's active notice_templates row for template rendering when
 * available; falls back to hardcoded HTML if no template exists.
 *
 * Input (POST JSON):
 *   notice_type        — 'written_warning' | 'notice_to_vacate' | 'infringement'
 *   breach_alert_id    — UUID of the breach_alert
 *   officer_name       — Authorising officer display name
 *   location_name      — Site/zone name for the notice
 *   additional_notes   — Optional extra notes
 *   authorized_by      — Name of authorising supervisor
 *
 * Output:
 *   { ok: true, html: string, notice_id: string, pdf_url: string, html_storage_path: string }
 *
 * Legal boundary:
 *   This function only generates a draft HTML document.
 *   No notice is formally issued until the admin prints and signs.
 *   The breach_alert action_type is updated to reflect the draft.
*/ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb, type PDFFont } from 'https://esm.sh/pdf-lib@1.17.1';
import { embedPdfNotoFonts } from '../_shared/pdf-noto-fonts.ts';
import { pdfTextFontRuns, wrapPdfText, type PdfTextFontPair } from '../_shared/pdf-text-fonts.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const PDF_RENDERER_VERSION = 'fcm-notice-pdf-lib-a4-v5';
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

interface NoticeHtmlData {
  noticeType: string;
  noticeNumber: string;
  plate: string;
  zoneName: string;
  siteName: string;
  siteAddress: string;
  orgName: string;
  officerName: string;
  authorizedBy: string;
  noticeDate: string;
  vacateBy: string;
  fineAmount: number;
  paymentUrl: string;
  objectionsEmail: string;
  objectionsAddress: string;
  bylawRef: string;
  additionalNotes: string;
  breachType: string;
  customBody?: string;
  footerText?: string;
  logoUrl?: string;
  issuingAuthority?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function htmlToLines(html: string): string[] {
  return html.replace(/<br\s*\/?><\/p>/gi, '\n').replace(/<\/(p|div|h1|h2|h3|li|tr|footer)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function buildNoticePdfBytes(html: string, title: string, noticeNumber: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { normal, bold } = await embedPdfNotoFonts(pdf);
  pdf.setTitle(title);
  pdf.setSubject(`Notice ${noticeNumber}`);
  pdf.setCreator('Field Compliance Manager');
  const lines = htmlToLines(html);
  let page = pdf.addPage([595, 842]);
  let y = 780;
  const drawLine = (text: string, fonts: PdfTextFontPair<PDFFont> = normal, size = 10) => {
    for (const line of wrapPdfText(text, fonts, size, 487)) {
      if (y < 64) {
        page = pdf.addPage([595, 842]);
        y = 780;
      }
      let x = 54;
      for (const run of pdfTextFontRuns(line, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.08, 0.08, 0.08) });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      y -= size + 6;
    }
  };
  drawLine(title, bold, 17);
  drawLine(`Notice number: ${noticeNumber}`, normal, 9);
  drawLine(`Generated ${new Date().toISOString()}`, normal, 9);
  page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 541, y: y + 2 }, thickness: 1.5, color: rgb(0.18, 0.18, 0.18) });
  y -= 14;
  for (const line of lines) drawLine(line);
  drawLine('This PDF is a generated notice artifact. The notice remains subject to the recorded signature and issue workflow.', normal, 8);
  return pdf.save();
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: corsHeaders
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: corsHeaders
    });
    const body = await req.json();
    const { notice_type, breach_alert_id, officer_name, location_name, additional_notes, authorized_by, infringement_fee } = body;
    const module_key = body.module_key ?? 'freedom_camping';
    if (!notice_type || !breach_alert_id) {
      return new Response(JSON.stringify({
        error: 'notice_type and breach_alert_id are required'
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    // The zone's address is its house's address (locations); zones carry no address of their own.
    const { data: alert, error: alertErr } = await supabase.from('breach_alerts').select(`
        id, plate_number, breach_type, created_at, zone_id, organization_id,
        location_zones(name, locations(address))
      `).eq('id', breach_alert_id).single();
    if (alertErr || !alert) {
      return new Response(JSON.stringify({
        error: 'Breach alert not found'
      }), {
        status: 404,
        headers: corsHeaders
      });
    }
    const { data: profile } = await supabase.from('user_profiles').select('role, organization_id').eq('id', user.id).single();
    if (!profile || !['grand_master', 'master', 'admin', 'admin_officer', 'officer'].includes(String(profile.role))) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
    }
    if (String(profile.role) !== 'grand_master' && profile.organization_id !== alert.organization_id) {
      return new Response(JSON.stringify({ error: 'Forbidden: breach alert belongs to another organization' }), { status: 403, headers: corsHeaders });
    }
    // Load org details
    const { data: org } = await supabase.from('organizations').select('name, contact_email, contact_phone').eq('id', alert.organization_id).single();
    // Bug D fix: load the org's active notice_templates row for this notice type
    // instead of the non-existent crm_jurisdiction_configs table.
    // module_key scoping: a single org can hold one active template per
    // (module_key, notice_type) so freedom_camping and parking_enforcement
    // (etc) never collide on shared wording.
    const { data: template } = await supabase.from('notice_templates').select('*').eq('organization_id', alert.organization_id).eq('module_key', module_key).eq('notice_type', notice_type).eq('is_active', true).order('version', {
      ascending: false
    }).limit(1).maybeSingle();
    // Build notice data from template (if available) or hardcoded defaults
    const plate = alert.plate_number ?? 'UNKNOWN';
    const zone = alert.location_zones;
    const zoneRecord = Array.isArray(zone) ? zone[0] : zone;
    const zoneLocation = Array.isArray(zoneRecord?.locations) ? zoneRecord.locations[0] : zoneRecord?.locations;
    const zoneName = zoneRecord?.name ?? location_name ?? 'Unknown location';
    const siteAddress = zoneLocation?.address ?? '';
    const orgName = org?.name ?? 'Field Compliance Manager';
    const noticeDate = new Date().toLocaleDateString('en-NZ', {
      dateStyle: 'long',
      timeZone: 'Pacific/Auckland'
    });
    // Vacate-by time: use template config or default 7:00am next morning
    const vacateBy = new Date();
    vacateBy.setDate(vacateBy.getDate() + 1);
    const vHour = template?.vacate_by_hour ?? 7;
    const vMin = template?.vacate_by_minute ?? 0;
    vacateBy.setHours(vHour, vMin, 0, 0);
    const vacateByStr = vacateBy.toLocaleDateString('en-NZ', {
      dateStyle: 'long',
      timeZone: 'Pacific/Auckland'
    }) + ` at ${String(vHour).padStart(2, '0')}:${String(vMin).padStart(2, '0')}`;
    const fineAmount = infringement_fee ?? template?.fine_amount ?? 200;
    const paymentUrl = template?.payment_url ?? '';
    const objectionsEmail = template?.objections_email ?? '';
    const objectionsAddress = template?.objections_address ?? '';
    const bylawRef = template?.bylaw_reference ?? template?.authorising_act ?? 'Freedom Camping Act 2011';
    const authorisingSection = template?.authorising_section ?? (notice_type === 'infringement' ? 's.20' : notice_type === 'notice_to_vacate' ? 's.32' : '');
    // Reserve infringement numbers atomically and scope counters by module.
    let noticeNumber = '';
    if (notice_type === 'infringement') {
      const { data: reservedNumber, error: numberError } = await supabase.rpc('reserve_infringement_notice_number', {
        p_organization_id: alert.organization_id,
        p_module_key: module_key,
        p_prefix: 'INF',
      });
      if (numberError || !reservedNumber) return new Response(JSON.stringify({ error: numberError?.message ?? 'Notice number could not be reserved' }), { status: 409, headers: corsHeaders });
      noticeNumber = reservedNumber;
    } else {
      // Non-infringement notices don't need sequential numbers
      noticeNumber = `${notice_type === 'notice_to_vacate' ? 'NTV' : 'WW'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${alert.id.slice(0, 6).toUpperCase()}`;
    }
    // Template rendering: if the org has a template with body_html, render it
    // with {{variable}} replacement. Otherwise fall back to hardcoded HTML.
    const noticeData = {
      noticeType: notice_type,
      noticeNumber,
      plate,
      zoneName,
      siteName: zoneName,
      siteAddress,
      orgName,
      officerName: officer_name ?? 'Authorised Officer',
      authorizedBy: authorized_by ?? officer_name ?? 'Authorised Officer',
      noticeDate,
      vacateBy: vacateByStr,
      fineAmount,
      paymentUrl,
      objectionsEmail,
      objectionsAddress,
      bylawRef,
      additionalNotes: additional_notes ?? '',
      breachType: alert.breach_type
    };
    let html;
    if (template?.body_html) {
      // Render template body with {{variable}} placeholders
      const renderedBody = template.body_html.replace(/\{\{plate\}\}/g, escapeHtml(plate)).replace(/\{\{zone\}\}/g, escapeHtml(zoneName)).replace(/\{\{officer\}\}/g, escapeHtml(noticeData.officerName)).replace(/\{\{date\}\}/g, escapeHtml(noticeDate)).replace(/\{\{vacate_by\}\}/g, escapeHtml(vacateByStr)).replace(/\{\{notice_number\}\}/g, escapeHtml(noticeNumber)).replace(/\{\{fine_amount\}\}/g, escapeHtml(String(fineAmount))).replace(/\{\{payment_url\}\}/g, escapeHtml(paymentUrl)).replace(/\{\{objections_address\}\}/g, escapeHtml(objectionsAddress)).replace(/\{\{objections_email\}\}/g, escapeHtml(objectionsEmail)).replace(/\{\{org_name\}\}/g, escapeHtml(orgName));
      // Wrap the rendered body in the standard notice HTML shell
      html = generateNoticeHtmlWithBody({
        ...noticeData,
        customBody: renderedBody,
        footerText: template.footer_text ?? '',
        logoUrl: template.logo_url ?? '',
        issuingAuthority: template.issuing_authority ?? orgName
      });
    } else {
      html = generateNoticeHtml(noticeData);
    }
    // Bug A fix: insert into the correct table based on notice_type
    let noticeId = null;
    if (notice_type === 'notice_to_vacate') {
      const { data: ntvRecord, error: ntvErr } = await supabase.from('notices_to_vacate').insert({
        organization_id: alert.organization_id,
        breach_alert_id,
        zone_id: alert.zone_id,
        plate_number: plate,
        vacate_by: vacateBy.toISOString(),
        reason: additional_notes ?? alert.breach_type,
        authorising_act: template?.authorising_act ?? 'Freedom Camping Act 2011',
        authorising_section: authorisingSection || 's.32',
        issued_by: user.id,
        issued_at: new Date().toISOString(),
        status: 'issued'
      }).select('id').single();
      if (ntvErr) console.error('NTV record error:', ntvErr.message);
      noticeId = ntvRecord?.id ?? null;
    } else if (notice_type === 'infringement') {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (template?.payment_deadline_days ?? 28));
      const { data: infRecord, error: infErr } = await supabase.from('infringement_notices').insert({
        organization_id: alert.organization_id,
        breach_alert_id,
        zone_id: alert.zone_id,
        notice_number: noticeNumber,
        plate_number: plate,
        offence_date: new Date().toISOString().slice(0, 10),
        offence_description: `Freedom camping breach: ${alert.breach_type.replace(/_/g, ' ')}. ${additional_notes ?? ''}`.trim(),
        authorising_act: template?.authorising_act ?? 'Freedom Camping Act 2011',
        authorising_section: authorisingSection || 's.20',
        amount: fineAmount,
        due_date: dueDate.toISOString().slice(0, 10),
        payment_url: paymentUrl,
        objections_email: objectionsEmail,
        issued_by: user.id,
        issued_at: new Date().toISOString(),
        status: 'issued'
      }).select('id').single();
      if (infErr) console.error('Infringement record error:', infErr.message);
      noticeId = infRecord?.id ?? null;
    }
    // written_warning: no separate notice table — breach_alerts update only
    // Store both the source HTML and a real PDF artifact. The HTML remains useful
    // for browser preview, while pdf_url points to the stable printable artifact.
    let pdfUrl = null;
    const storageId = noticeId ?? alert.id;
    const htmlPath = `org/${alert.organization_id}/notices/${storageId}.html`;
    const pdfPath = `org/${alert.organization_id}/notices/${storageId}.pdf`;
    const pdfBytes = await buildNoticePdfBytes(html, `${orgName} — ${noticeData.noticeType.replace(/_/g, ' ')}`, noticeNumber);
    const { error: htmlUploadErr } = await supabase.storage.from('notice-artifacts').upload(htmlPath, new Blob([html], { type: 'text/html' }), {
      contentType: 'text/html',
      upsert: true
    });
    const { error: pdfUploadErr } = await supabase.storage.from('notice-artifacts').upload(pdfPath, new Blob([Uint8Array.from(pdfBytes).buffer], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: true
    });
    if (htmlUploadErr || pdfUploadErr) {
      console.error('Notice artifact upload error:', htmlUploadErr?.message ?? pdfUploadErr?.message);
    } else {
      pdfUrl = pdfPath;
      // Update the notice row with the storage path
      if (notice_type === 'notice_to_vacate' && noticeId) {
        await supabase.from('notices_to_vacate').update({
          pdf_url: pdfUrl
        }).eq('id', noticeId);
      } else if (notice_type === 'infringement' && noticeId) {
        await supabase.from('infringement_notices').update({
          pdf_url: pdfUrl
        }).eq('id', noticeId);
      }
    }
    // Update breach alert
    await supabase.from('breach_alerts').update({
      action_type: notice_type,
      status: 'actioned',
      actioned_by: user.id,
      actioned_at: new Date().toISOString()
    }).eq('id', breach_alert_id);
    return new Response(JSON.stringify({
      ok: true,
      html,
      notice_id: noticeId,
      pdf_url: pdfUrl,
      html_storage_path: htmlPath,
      pdf_renderer_version: PDF_RENDERER_VERSION,
      // Structured fields for narrow receipt-printer rendering (thermalReceipt.ts
      // on the client) — avoids parsing the HTML shell to recover plate/amount/etc.
      receipt: {
        orgName,
        noticeType: notice_type,
        noticeNumber,
        issuedAtIso: new Date().toISOString(),
        subjectLabel: 'Plate',
        subjectValue: plate,
        locationLabel: zoneName,
        officerName: noticeData.officerName,
        legalBasis: [bylawRef, authorisingSection].filter(Boolean).join(' '),
        fineAmount: notice_type === 'infringement' ? fineAmount : null,
        dueDateIso: notice_type === 'notice_to_vacate' ? vacateBy.toISOString() : null,
        notes: additional_notes ?? null,
        footerText: template?.footer_text ?? null
      }
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({
      error: msg
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
function generateNoticeHtmlWithBody(d: NoticeHtmlData): string {
  const titles: Record<string, string> = {
    written_warning: 'WRITTEN WARNING',
    notice_to_vacate: 'NOTICE TO VACATE',
    infringement: 'INFRINGEMENT NOTICE'
  };
  const title = titles[d.noticeType] ?? 'NOTICE';
  const noticeNumber = escapeHtml(d.noticeNumber);
  const issuingAuthority = escapeHtml(d.issuingAuthority ?? '');
  const logoUrl = d.logoUrl?.trim() && /^https:\/\//i.test(d.logoUrl.trim()) ? escapeHtml(d.logoUrl.trim()) : '';
  const officerName = escapeHtml(d.officerName);
  const authorizedBy = escapeHtml(d.authorizedBy);
  const noticeDate = escapeHtml(d.noticeDate);
  const footerText = escapeHtml(d.footerText ?? '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${noticeNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; color: #000; background: #fff; padding: 20mm; }
    .header { border-bottom: 3px solid #000; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .org-name { font-size: 16pt; font-weight: bold; }
    .notice-type { font-size: 20pt; font-weight: bold; text-align: right; }
    .notice-number { font-size: 10pt; color: #555; text-align: right; margin-top: 4px; }
    .body { margin-bottom: 24px; line-height: 1.6; }
    .body p { margin-bottom: 12px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .detail-table td { padding: 6px 10px; border: 1px solid #ccc; vertical-align: top; }
    .detail-table td:first-child { width: 40%; font-weight: bold; background: #f5f5f5; }
    .signature-section { margin-top: 40px; display: flex; gap: 60px; }
    .sig-block { flex: 1; }
    .sig-line { border-bottom: 1px solid #000; height: 40px; margin-bottom: 6px; }
    .sig-label { font-size: 10pt; color: #555; }
    .footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; font-size: 9pt; color: #777; }
    .watermark { color: #d00; font-weight: bold; font-size: 10pt; margin-bottom: 8px; }
    .logo { max-height: 60px; margin-bottom: 8px; }
    @media print {
      body { padding: 15mm; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      ${logoUrl ? `<img class="logo" src="${logoUrl}" alt="${issuingAuthority}" />` : ''}
      <div class="org-name">${issuingAuthority}</div>
      <div style="font-size:10pt;color:#555;margin-top:4px;">Authorised Enforcement Officer</div>
    </div>
    <div>
      <div class="notice-type">${title}</div>
      <div class="notice-number">${noticeNumber}</div>
    </div>
  </div>

  <div class="watermark">DRAFT — FOR AUTHORISED OFFICER USE ONLY — NOT VALID UNTIL SIGNED</div>

  <div class="body">
    ${d.customBody}
  </div>

  <div class="signature-section">
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Officer signature: ${officerName}</div>
    </div>
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Authorised by: ${authorizedBy}</div>
    </div>
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Date: ${noticeDate}</div>
    </div>
  </div>

  <div class="footer">
    ${footerText || `Issued under ${escapeHtml(d.bylawRef)}. This notice was generated by ${issuingAuthority} field compliance system. Notice number: ${noticeNumber}. For queries contact ${issuingAuthority}.`}
  </div>
</body>
</html>`;
}
function generateNoticeHtml(d: NoticeHtmlData): string {
  const titles: Record<string, string> = {
    written_warning: 'WRITTEN WARNING',
    notice_to_vacate: 'NOTICE TO VACATE',
    infringement: 'INFRINGEMENT NOTICE'
  };
  const title = titles[d.noticeType] ?? 'NOTICE';
  const noticeNumber = escapeHtml(d.noticeNumber);
  const plate = escapeHtml(d.plate);
  const zoneName = escapeHtml(d.zoneName);
  const siteName = escapeHtml(d.siteName);
  const siteAddress = escapeHtml(d.siteAddress);
  const noticeDate = escapeHtml(d.noticeDate);
  const bylawRef = escapeHtml(d.bylawRef);
  const paymentUrl = escapeHtml(d.paymentUrl);
  const objectionsEmail = escapeHtml(d.objectionsEmail);
  const additionalNotes = escapeHtml(d.additionalNotes);
  const vacateBy = escapeHtml(d.vacateBy);
  const orgName = escapeHtml(d.orgName);
  const officerName = escapeHtml(d.officerName);
  const authorizedBy = escapeHtml(d.authorizedBy);
  const bodyContent = d.noticeType === 'infringement' ? `
      <p>You are hereby issued an infringement notice under <strong>${bylawRef}</strong> for freedom camping in a prohibited area.</p>
      <table class="detail-table">
        <tr><td>Vehicle plate:</td><td><strong>${plate}</strong></td></tr>
        <tr><td>Location:</td><td>${zoneName}${siteName ? ` — ${siteName}` : ''}</td></tr>
        <tr><td>Address:</td><td>${siteAddress}</td></tr>
        <tr><td>Date of offence:</td><td>${noticeDate}</td></tr>
        <tr><td>Notice number:</td><td><strong>${noticeNumber}</strong></td></tr>
        <tr><td>Fine amount:</td><td><strong>NZD $${d.fineAmount.toFixed(2)}</strong></td></tr>
        <tr><td>Payment due:</td><td>Within 28 days of this notice</td></tr>
        ${paymentUrl ? `<tr><td>Pay online:</td><td>${paymentUrl}</td></tr>` : ''}
        ${objectionsEmail ? `<tr><td>Objections to:</td><td>${objectionsEmail}</td></tr>` : ''}
      </table>
      <p>Failure to pay within 28 days may result in further enforcement action.</p>
      ${additionalNotes ? `<p><strong>Additional notes:</strong> ${additionalNotes}</p>` : ''}
    ` : d.noticeType === 'notice_to_vacate' ? `
      <p>You are hereby directed to vacate the following location under <strong>${bylawRef}</strong>.</p>
      <table class="detail-table">
        <tr><td>Vehicle plate:</td><td><strong>${plate}</strong></td></tr>
        <tr><td>Location:</td><td>${zoneName}${siteName ? ` — ${siteName}` : ''}</td></tr>
        <tr><td>Address:</td><td>${siteAddress}</td></tr>
        <tr><td>Date issued:</td><td>${noticeDate}</td></tr>
        <tr><td>Vacate by:</td><td><strong>${vacateBy}</strong></td></tr>
      </table>
      <p>Failure to vacate by the time specified may result in an infringement notice being issued.</p>
      ${additionalNotes ? `<p><strong>Additional notes:</strong> ${additionalNotes}</p>` : ''}
    ` : `
      <p>This is a formal written warning regarding freedom camping at the following location.</p>
      <table class="detail-table">
        <tr><td>Vehicle plate:</td><td><strong>${plate}</strong></td></tr>
        <tr><td>Location:</td><td>${zoneName}${siteName ? ` — ${siteName}` : ''}</td></tr>
        <tr><td>Date issued:</td><td>${noticeDate}</td></tr>
      </table>
      <p>Please ensure you comply with freedom camping regulations. Further non-compliance may result in a Notice to Vacate or Infringement Notice.</p>
      ${additionalNotes ? `<p><strong>Additional notes:</strong> ${additionalNotes}</p>` : ''}
    `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${noticeNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; color: #000; background: #fff; padding: 20mm; }
    .header { border-bottom: 3px solid #000; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .org-name { font-size: 16pt; font-weight: bold; }
    .notice-type { font-size: 20pt; font-weight: bold; text-align: right; }
    .notice-number { font-size: 10pt; color: #555; text-align: right; margin-top: 4px; }
    .body { margin-bottom: 24px; line-height: 1.6; }
    .body p { margin-bottom: 12px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .detail-table td { padding: 6px 10px; border: 1px solid #ccc; vertical-align: top; }
    .detail-table td:first-child { width: 40%; font-weight: bold; background: #f5f5f5; }
    .signature-section { margin-top: 40px; display: flex; gap: 60px; }
    .sig-block { flex: 1; }
    .sig-line { border-bottom: 1px solid #000; height: 40px; margin-bottom: 6px; }
    .sig-label { font-size: 10pt; color: #555; }
    .footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; font-size: 9pt; color: #777; }
    .watermark { color: #d00; font-weight: bold; font-size: 10pt; margin-bottom: 8px; }
    @media print {
      body { padding: 15mm; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="org-name">${orgName}</div>
      <div style="font-size:10pt;color:#555;margin-top:4px;">Authorised Enforcement Officer</div>
    </div>
    <div>
      <div class="notice-type">${title}</div>
      <div class="notice-number">${noticeNumber}</div>
    </div>
  </div>

  <div class="watermark">DRAFT — FOR AUTHORISED OFFICER USE ONLY — NOT VALID UNTIL SIGNED</div>

  <div class="body">
    ${bodyContent}
  </div>

  <div class="signature-section">
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Officer signature: ${officerName}</div>
    </div>
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Authorised by: ${authorizedBy}</div>
    </div>
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-label">Date: ${noticeDate}</div>
    </div>
  </div>

  <div class="footer">
    Issued under ${bylawRef}. This notice was generated by ${orgName} field compliance system.
    Notice number: ${noticeNumber}. For queries contact ${orgName}.
  </div>
</body>
</html>`;
}
