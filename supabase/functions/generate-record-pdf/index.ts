import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb, type PDFImage, type PDFFont } from 'https://esm.sh/pdf-lib@1.17.1';
import { embedPdfNotoFonts } from '../_shared/pdf-noto-fonts.ts';
import { pdfTextFontRuns } from '../_shared/pdf-text-fonts.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const bucket = 'bob-uploads';
const rendererVersion = 'fcm-record-pdf-lib-a4-v1';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type RecordKind = 'observation' | 'location_event';
type SupabaseClient = ReturnType<typeof createClient<any>>;

interface PdfFontPair {
  latin: PDFFont;
  latinExtended: PDFFont;
  latinCodePoints: ReadonlySet<number>;
  latinExtendedCodePoints: ReadonlySet<number>;
}

interface EvidenceRow {
  id: string;
  storage_path: string | null;
  captured_at: string;
  sha256_hash: string | null;
  metadata: Record<string, unknown> | null;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function valueText(value: unknown, fallback = 'Not recorded'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function nestedText(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null;
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
}

function textWidth(text: string, fonts: PdfFontPair, size: number): number {
  return pdfTextFontRuns(text, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)
    .reduce((total, run) => total + run.font.widthOfTextAtSize(run.text, size), 0);
}

function splitToken(token: string, fonts: PdfFontPair, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of Array.from(token)) {
    const candidate = `${chunk}${character}`;
    if (chunk && textWidth(candidate, fonts, size) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapText(text: string, fonts: PdfFontPair, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean).flatMap((word) => splitToken(word, fonts, size, maxWidth));
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, fonts, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line || ' ');
  }
  return lines;
}

function safeFilename(value: string): string {
  const stem = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 140);
  return `${stem || 'FCM record'}.pdf`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function loadAuthorizedRecord(req: Request, kind: RecordKind, recordId: string) {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) throw new RequestError('Unauthorized', 401);
  const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) throw new RequestError('Unauthorized', 401);

  const table = kind === 'observation' ? 'observations' : 'location_events';
  const { data: visible, error: visibilityError } = await caller
    .from(table)
    .select('id,organization_id')
    .eq('id', recordId)
    .maybeSingle();
  if (visibilityError) throw new RequestError(visibilityError.message, 403);
  if (!visible) throw new RequestError('Record not found or not permitted', 404);

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile } = await admin.from('user_profiles').select('deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile || profile.deactivated_at) throw new RequestError('Active user account required', 403);

  const select = kind === 'observation'
    ? 'id,organization_id,observed_at,subject_kind,plate_number,officer_notes,reported_by_name,is_compliant,compliance_reason,distance_km,source_document_name,source_reference,source_sha256,source_locator,canonical_vehicle_id,canonical_person_id,person_record:person_record_id(display_name),zone:zone_id(name),site:site_id(name)'
    : 'id,organization_id,occurred_at,event_type,module_key,status,source,distance_km,payload,observed_entity_type,zone:zone_id(name),site:client_site_id(name)';
  const { data: record, error: recordError } = await admin.from(table).select(select).eq('id', recordId).single();
  if (recordError || !record) throw new RequestError('Record could not be loaded', 404);
  if (record.organization_id !== visible.organization_id) throw new RequestError('Record tenant mismatch', 409);

  return { admin, userId: user.id, record };
}

async function loadEvidence(admin: SupabaseClient, organizationId: string, kind: RecordKind, recordId: string): Promise<EvidenceRow[]> {
  let query = admin.from('evidence_items')
    .select('id,storage_path,captured_at,sha256_hash,metadata')
    .eq('organization_id', organizationId)
    .order('captured_at', { ascending: true });
  query = kind === 'location_event'
    ? query.eq('location_event_id', recordId)
    : query.eq('metadata->>observation_id', recordId);
  const { data, error } = await query;
  if (error) throw new RequestError(error.message, 502);
  return (data ?? []) as EvidenceRow[];
}

async function embedEvidenceImage(pdf: PDFDocument, admin: SupabaseClient, row: EvidenceRow): Promise<PDFImage | null> {
  if (!row.storage_path) return null;
  const extension = row.storage_path.split('.').pop()?.toLowerCase();
  if (extension !== 'jpg' && extension !== 'jpeg' && extension !== 'png') return null;
  const { data, error } = await admin.storage.from(bucket).download(row.storage_path);
  if (error || !data || data.size > 8 * 1024 * 1024) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  return extension === 'png' ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

function recordRows(kind: RecordKind, record: Record<string, unknown>): Array<[string, string]> {
  if (kind === 'observation') {
    const personName = nestedText(record.person_record, 'display_name');
    const compliance = record.is_compliant === null
      ? 'Not assessed'
      : `${record.is_compliant === true ? 'Compliant' : 'Non-compliant'}${typeof record.compliance_reason === 'string' && record.compliance_reason ? ` - ${record.compliance_reason}` : ''}`;
    return [
      ['When', formatDate(record.observed_at)],
      ['Subject', personName ?? valueText(record.plate_number, valueText(record.subject_kind, 'Unidentified observation'))],
      ['Subject type', valueText(record.subject_kind)],
      ['Place', nestedText(record.zone, 'name') ?? nestedText(record.site, 'name') ?? 'Unassigned place'],
      ['Reported by', valueText(record.reported_by_name)],
      ['Officer notes', valueText(record.officer_notes, 'No notes recorded')],
      ['Compliance', compliance],
      ['Distance', record.distance_km == null ? 'Not recorded' : `${record.distance_km} km`],
      ['Canonical vehicle', valueText(record.canonical_vehicle_id, 'Not linked')],
      ['Canonical person', valueText(record.canonical_person_id, 'Not linked')],
      ['Source document', valueText(record.source_document_name)],
      ['Source reference', valueText(record.source_reference)],
      ['Source locator', valueText(record.source_locator)],
      ['Source SHA-256', valueText(record.source_sha256)],
    ];
  }
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {};
  return [
    ['When', formatDate(record.occurred_at)],
    ['Activity', valueText(record.event_type).replaceAll('_', ' ')],
    ['Place', nestedText(record.zone, 'name') ?? nestedText(record.site, 'name') ?? 'Unassigned place'],
    ['Status', valueText(record.status)],
    ['Module', valueText(record.module_key)],
    ['Source', valueText(record.source)],
    ['Patroller', valueText(payload.patroller)],
    ['Officer comments', valueText(payload.comments, 'No comments recorded')],
    ['Issue', valueText(payload.issue)],
    ['Action by', valueText(payload.action_by)],
    ['Action notes', valueText(payload.action_notes)],
    ['Last action', valueText(payload.last_action_date)],
    ['Closed by', valueText(payload.closed_by)],
    ['Source file', valueText(payload.source_file)],
    ['Source sheet / row', [valueText(payload.source_sheet, ''), payload.source_row == null ? '' : `row ${payload.source_row}`].filter(Boolean).join(' - ') || 'Not recorded'],
  ];
}

async function renderRecordPdf(
  kind: RecordKind,
  record: Record<string, unknown>,
  evidence: EvidenceRow[],
  admin: SupabaseClient,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setLanguage('en-NZ');
  const { normal, bold } = await embedPdfNotoFonts(pdf);
  const title = kind === 'observation'
    ? `Observation ${valueText(record.plate_number, String(record.id).slice(0, 8))}`
    : `Patrol record ${formatDate(record.occurred_at)}`;
  pdf.setTitle(title);
  pdf.setSubject(`${kind.replace('_', ' ')} ${record.id}`);
  pdf.setCreator('Field Compliance Manager');

  let page = pdf.addPage([595, 842]);
  let y = 788;
  const draw = (value: string, fonts: PdfFontPair = normal, size = 10, indent = 0) => {
    for (const line of wrapText(value, fonts, size, 487 - indent)) {
      if (y < 64) {
        page = pdf.addPage([595, 842]);
        y = 788;
      }
      let x = 54 + indent;
      for (const run of pdfTextFontRuns(line, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.08, 0.12, 0.13) });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      y -= size + 5;
    }
  };

  draw('FIELD COMPLIANCE MANAGER', bold, 9);
  draw(title, bold, 18);
  draw(`Record ID: ${record.id}`, normal, 8);
  draw(`Generated: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}`, normal, 8);
  y -= 8;
  page.drawLine({ start: { x: 54, y }, end: { x: 541, y }, thickness: 1.2, color: rgb(0.18, 0.49, 0.45) });
  y -= 18;

  for (const [label, value] of recordRows(kind, record)) {
    draw(label.toUpperCase(), bold, 8);
    draw(value);
    y -= 5;
  }

  draw(`Evidence (${evidence.length})`, bold, 13);
  y -= 4;
  if (evidence.length === 0) draw('No linked evidence items were available when this PDF was generated.');
  for (const item of evidence.slice(0, 12)) {
    const description = typeof item.metadata?.description === 'string' && item.metadata.description
      ? item.metadata.description
      : 'Evidence item';
    draw(description, bold, 9);
    draw(`${formatDate(item.captured_at)}${item.sha256_hash ? ` - SHA-256 ${item.sha256_hash}` : ''}`, normal, 8);
  }

  const imageRows = evidence.filter((item) => item.storage_path).slice(0, 4);
  for (const item of imageRows) {
    const image = await embedEvidenceImage(pdf, admin, item);
    if (!image) continue;
    page = pdf.addPage([595, 842]);
    y = 788;
    const description = typeof item.metadata?.description === 'string' && item.metadata.description
      ? item.metadata.description
      : 'Evidence photo';
    draw(description, bold, 12);
    draw(`${formatDate(item.captured_at)}${item.sha256_hash ? ` - SHA-256 ${item.sha256_hash}` : ''}`, normal, 8);
    y -= 12;
    const scale = Math.min(487 / image.width, 620 / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: 54 + (487 - width) / 2, y: Math.max(54, y - height), width, height });
  }

  return pdf.save();
}

async function handle(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const kind = body.record_kind === 'observation' || body.record_kind === 'location_event'
    ? body.record_kind
    : null;
  const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : '';
  if (!kind || !recordId) throw new RequestError('record_kind and record_id are required', 400);

  const { admin, userId, record } = await loadAuthorizedRecord(req, kind, recordId);
  const evidence = await loadEvidence(admin, record.organization_id, kind, recordId);
  const bytes = await renderRecordPdf(kind, record, evidence, admin);
  const checksum = await sha256(bytes);
  const path = `org/${record.organization_id}/record-pdfs/${kind}/${recordId}/${checksum}.pdf`;
  const { error: uploadError } = await admin.storage.from(bucket).upload(
    path,
    new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }),
    { upsert: false, contentType: 'application/pdf' },
  );
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) {
    throw new RequestError(uploadError.message, 502);
  }

  const { error: auditError } = await admin.from('audit_log').insert({
    organization_id: record.organization_id,
    actor_user_id: userId,
    action: 'record_pdf_generated',
    target_table: kind === 'observation' ? 'observations' : 'location_events',
    target_id: recordId,
    metadata: {
      renderer_version: rendererVersion,
      pdf_path: path,
      pdf_sha256: checksum,
      evidence_count: evidence.length,
    },
  });
  if (auditError) throw new RequestError(`PDF generated but audit receipt failed: ${auditError.message}`, 502);

  const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUrl(path, 900);
  if (signedError || !signed?.signedUrl) throw new RequestError(signedError?.message ?? 'Download link could not be created', 502);

  const title = kind === 'observation'
    ? `Observation ${valueText(record.plate_number, recordId.slice(0, 8))}`
    : `Patrol record ${String(record.occurred_at).slice(0, 10)}`;
  return json({
    ok: true,
    signed_url: signed.signedUrl,
    file_name: safeFilename(title),
    sha256: checksum,
    evidence_count: evidence.length,
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    return await handle(req);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Record PDF generation failed' }, 500);
  }
});
