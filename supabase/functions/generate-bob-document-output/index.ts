import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { strToU8, zipSync } from 'https://esm.sh/fflate@0.8.2';
import { embedPdfNotoFonts } from '../_shared/pdf-noto-fonts.ts';
import { pdfTextFontRuns, wrapPdfText } from '../_shared/pdf-text-fonts.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const PDF_RENDERER_VERSION = 'fcm-pdf-lib-a4-v5';
const DOCX_RENDERER_VERSION = 'fcm-ooxml-docx-v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const hex = (bytes: Uint8Array) => Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'br', 'hr', 'a']);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
function sanitizeHtml(input: string) {
  return input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base)[^>]*>/gi, '')
    .replace(/<([^>]+)>/g, (full, rawTag: string) => {
      const closing = rawTag.trim().startsWith('/');
      const match = rawTag.trim().match(/^\/?\s*([a-z0-9]+)([\s\S]*)$/i);
      if (!match || !ALLOWED_TAGS.has(match[1].toLowerCase())) return '';
      const tag = match[1].toLowerCase();
      if (closing || tag !== 'a') return `<${closing ? '/' : ''}${tag}>`;
      const href = match[2].match(/href\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
      if (!href || /^(?:javascript|vbscript|data):/i.test(href.trim())) return '<a>';
      return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">`;
    });
}
function htmlToLines(input: string) {
  return input.replace(/<\/(p|h1|h2|h3|li|blockquote|pre)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function escapeXml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}
function docxParagraph(text: string, style?: string) {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}
function buildDocxBytes(organizationName: string, title: string, lines: string[]) {
  const paragraphs = [
    docxParagraph(organizationName, 'Title'),
    docxParagraph(title, 'Heading1'),
    docxParagraph(`Approved FCM document output · Generated ${new Date().toISOString()}`),
    ...lines.map((line) => docxParagraph(line)),
    docxParagraph('Source and approval metadata remain available in the FCM document record.'),
    docxParagraph('This output is not legal advice.'),
  ].join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style></w:styles>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
  };
  return zipSync(files, { level: 6 });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const body = await req.json().catch(() => ({}));
    const outputId = String(body.output_id ?? '').trim();
    if (!outputId) return json({ error: 'output_id is required' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !['grand_master', 'master', 'admin', 'admin_officer'].includes(String(profile.role))) return json({ error: 'Administrator approval required' }, 403);
    const { data: output, error: outputError } = await admin.from('bob_generated_document_outputs').select('id,organization_id,document_id,document_version_id,output_format,status').eq('id', outputId).single();
    if (outputError || !output) return json({ error: 'Output request not found' }, 404);
    if (String(profile.role) !== 'grand_master' && output.organization_id !== profile.organization_id) return json({ error: 'Forbidden' }, 403);
    if (output.status !== 'requested') return json({ error: 'Output request is not in requested state' }, 409);
    if (!['pdf', 'print', 'docx'].includes(output.output_format)) return json({ error: 'Unsupported output format' }, 422);

    const { data: version } = await admin.from('document_versions').select('id,metadata_json,extracted_text').eq('id', output.document_version_id).single();
    if (!version || String(version.metadata_json?.authoring_status ?? '') !== 'approved') return json({ error: 'Only approved document versions can be rendered' }, 422);
    const { data: organization } = await admin.from('organizations').select('name').eq('id', output.organization_id).single();
    const organizationName = String(organization?.name ?? 'Field Compliance Manager');
    const { data: brandAsset } = await admin.from('organization_brand_assets').select('asset_url,storage_bucket,storage_path,mime_type').eq('organization_id', output.organization_id).eq('asset_kind', 'logo').eq('variant', 'default').eq('status', 'approved').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const title = String(version.metadata_json?.title ?? 'FCM document');
    const authoredHtml = sanitizeHtml(String(version.metadata_json?.authoring_html ?? `<p>${escapeHtml(String(version.extracted_text ?? ''))}</p>`));
    const lines = htmlToLines(authoredHtml);
    let bytes: Uint8Array;
    let mimeType = 'application/pdf';
    let rendererVersion = PDF_RENDERER_VERSION;
    if (output.output_format === 'docx') {
      bytes = buildDocxBytes(organizationName, title, lines);
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      rendererVersion = DOCX_RENDERER_VERSION;
    } else {
      const pdfDoc = await PDFDocument.create();
      const { normal, bold } = await embedPdfNotoFonts(pdfDoc);
      pdfDoc.setTitle(title);
      pdfDoc.setAuthor(organizationName);
      pdfDoc.setSubject('Approved FCM document output');
      pdfDoc.setCreator('Field Compliance Manager');
      let page = pdfDoc.addPage([595, 842]);
      let y = 780;
      if (brandAsset) {
        try {
          let logoBytes: Uint8Array | null = null;
          if (brandAsset.storage_bucket && brandAsset.storage_path) {
            const logo = await admin.storage.from(brandAsset.storage_bucket).download(brandAsset.storage_path);
            if (!logo.error && logo.data) logoBytes = new Uint8Array(await logo.data.arrayBuffer());
          } else if (brandAsset.asset_url?.startsWith('https://')) {
            const logoResponse = await fetch(brandAsset.asset_url);
            if (logoResponse.ok) logoBytes = new Uint8Array(await logoResponse.arrayBuffer());
          }
          if (logoBytes) {
            const image = String(brandAsset.mime_type ?? '').includes('png') ? await pdfDoc.embedPng(logoBytes) : await pdfDoc.embedJpg(logoBytes);
            const scale = Math.min(120 / image.width, 45 / image.height);
            page.drawImage(image, { x: 54, y: y - image.height * scale, width: image.width * scale, height: image.height * scale });
            y -= image.height * scale + 12;
          }
        } catch (_logoError) {
          // A missing or unsupported logo must degrade to text branding, not fail the document output.
        }
      }
      const drawText = (text: string, fonts = normal, size = 10) => {
        for (const line of wrapPdfText(text, fonts, size, 487)) {
          if (y < 70) { page = pdfDoc.addPage([595, 842]); y = 780; }
          let x = 54;
          for (const run of pdfTextFontRuns(line, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
            page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.09, 0.17, 0.18) });
            x += run.font.widthOfTextAtSize(run.text, size);
          }
          y -= size + 7;
        }
      };
      drawText(organizationName, bold, 15);
      drawText(title, bold, 18);
      drawText(`Approved FCM document output · Generated ${new Date().toISOString()}`, normal, 9);
      page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 541, y: y + 2 }, thickness: 1.5, color: rgb(0.18, 0.49, 0.45) }); y -= 16;
      for (const line of lines) drawText(line, normal, 10);
      if (y < 90) { page = pdfDoc.addPage([595, 842]); y = 780; }
      drawText('Source and approval metadata remain available in the FCM document record.', normal, 8);
      drawText('This output is not legal advice.', normal, 8);
      bytes = await pdfDoc.save();
    }
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    const sha256 = hex(new Uint8Array(digest));
    const storagePath = `org/${output.organization_id}/generated/${output.document_id}/${output.id}.html`;
    const outputExtension = output.output_format === 'docx' ? 'docx' : output.output_format === 'pdf' ? 'pdf' : 'print.pdf';
    const finalStoragePath = storagePath.replace(/\.html$/, `.${outputExtension}`);
    const { error: uploadError } = await admin.storage.from('bob-uploads').upload(finalStoragePath, new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }), { upsert: false, contentType: mimeType });
    if (uploadError) throw new Error(uploadError.message);
    const { data: updated, error: updateError } = await admin.from('bob_generated_document_outputs').update({ status: 'ready', storage_bucket: 'bob-uploads', storage_path: finalStoragePath, mime_type: mimeType, renderer_version: rendererVersion, sha256, generated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', output.id).eq('status', 'requested').select('id,status,output_format,mime_type,renderer_version,sha256,storage_bucket,storage_path').single();
    if (updateError || !updated) throw new Error(updateError?.message ?? 'Output state could not be updated');
    await admin.from('audit_log').insert({ organization_id: output.organization_id, actor_user_id: user.id, action: 'bob_document_output_generated', target_table: 'bob_generated_document_outputs', target_id: output.id, metadata: { document_id: output.document_id, document_version_id: output.document_version_id, output_format: output.output_format, mime_type: mimeType, renderer_version: rendererVersion, sha256 } });
    return json({ success: true, output: updated });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Document output generation failed' }, 500);
  }
});
