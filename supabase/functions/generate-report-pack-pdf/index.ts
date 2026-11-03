/**
 * generate-report-pack-pdf -- render one generated monthly report pack to a
 * private PDF artifact for provider and agreement-authorized client access.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage } from 'https://esm.sh/pdf-lib@1.17.1';
import { embedPdfNotoFonts } from '../_shared/pdf-noto-fonts.ts';
import { pdfFontTextWidth, pdfTextFontRuns, pdfTextWidth, wrapPdfText } from '../_shared/pdf-text-fonts.ts';
import { monthlyActivityBlocks, siteLogBlocks, type ReportBlock, type ReportPhotoRef } from '../_shared/report-activity-sections.ts';
import { loadReportPhotos, reportPhotoKey } from '../_shared/report-photos.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const rendererVersion = 'fcm-report-pack-pdf-lib-a4-v14';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))).map((value) => value.toString(16).padStart(2, '0')).join('');
const canRender = new Set(['grand_master', 'master', 'admin', 'admin_officer']);

type SupabaseClient = ReturnType<typeof createClient<any>>;

interface PdfAgreement {
  name: string;
  client?: { name: string } | Array<{ name: string }> | null;
}

interface PdfReportPack {
  id: string;
  agreement: PdfAgreement | PdfAgreement[] | null;
  provider: { name: string } | Array<{ name: string }> | null;
  organization_id: string;
  period_start: string;
  period_end: string;
  template_code: string;
  status: string;
  data: Record<string, unknown> | null;
  activity_lines: Record<string, unknown> | null;
  editorial: Record<string, unknown> | null;
  generated_at: string | null;
  report_kind: string;
  report_scope: Record<string, unknown>;
  updated_at: string;
  pdf_path: string | null;
  delivery_channel: string | null;
}

interface PdfFontPair {
  latin: PDFFont;
  latinExtended: PDFFont;
  latinCodePoints: ReadonlySet<number>;
  latinExtendedCodePoints: ReadonlySet<number>;
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

const textWidth = (text: string, fonts: PdfFontPair, size: number) => pdfTextWidth(text, fonts, size);
const wrapText = (text: string, fonts: PdfFontPair, size: number, maxWidth: number) => wrapPdfText(text, fonts, size, maxWidth);

interface ReportRenderInput {
  templateTitle: string;
  agreementName: string;
  providerName: string | null;
  clientName: string | null;
  period: string;
  packId: string;
  snapshotGeneratedAt: string | null;
  editorial: Record<string, unknown>;
  data: unknown;
  activityLines: unknown;
  reportKind: string;
  reportScope: unknown;
  status: string;
  deliveryChannel: string | null;
  loadPhotos?: (refs: ReportPhotoRef[]) => Promise<Map<string, Uint8Array>>;
}

function availabilityLine(status: string, deliveryChannel: string | null) {
  if (status === 'draft') return 'Availability: provider-private draft for review.';
  if (deliveryChannel === 'portal') return 'Availability: published in the authorized client portal.';
  if (deliveryChannel === 'email') return 'Availability: prepared for approved primary-contact email delivery.';
  return 'Availability: governed provider report record.';
}

function relationName(value: { name: string } | Array<{ name: string }> | null | undefined) {
  const name = Array.isArray(value) ? value[0]?.name : value?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function reportAgreementName(pack: PdfReportPack) {
  return relationName(pack.agreement) ?? 'Service agreement';
}

function reportClientName(pack: PdfReportPack) {
  const agreement = Array.isArray(pack.agreement) ? pack.agreement[0] : pack.agreement;
  return relationName(agreement?.client);
}

function isoDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

/** "October 2026" for a whole calendar month, otherwise "1 October 2026 to 15 October 2026". */
export function reportPeriodLabel(start: string, end: string) {
  const from = isoDay(start);
  const to = isoDay(end);
  if (!from || !to) return `${start} to ${end}`;
  const format = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', ...options }).format(date);
  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  if (from.getUTCDate() === 1 && to.getUTCDate() === lastDay && from.getUTCFullYear() === to.getUTCFullYear() && from.getUTCMonth() === to.getUTCMonth()) {
    return format(from, { month: 'long', year: 'numeric' });
  }
  const long: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  return `${format(from, long)} to ${format(to, long)}`;
}

function preparedDate(value: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

const PAGE_SIZE: [number, number] = [595, 842];
const LEFT = 54;
const RIGHT = 541;
const WIDTH = RIGHT - LEFT;
const TOP = 786;
const BOTTOM = 66;
const PHOTOS_PER_ENTRY = 3;
const MAX_REPORT_PHOTOS = 60;
const INK = rgb(0.08, 0.12, 0.13);
const MUTED = rgb(0.38, 0.44, 0.46);
const BRAND = rgb(0.09, 0.33, 0.31);
const BRAND_SOFT = rgb(0.78, 0.9, 0.88);
const BRAND_TINT = rgb(0.92, 0.96, 0.95);
const RULE = rgb(0.78, 0.85, 0.84);
const ALERT = rgb(0.7, 0.2, 0.15);
const ALERT_TINT = rgb(0.99, 0.95, 0.94);
const STRIPE = rgb(0.97, 0.98, 0.98);
const WHITE = rgb(1, 1, 1);

// Summary gallery photos come first so they are fetched and converted first.
function entryPhotoRefs(blocks: ReportBlock[]) {
  const seen = new Set<string>();
  const refs: ReportPhotoRef[] = [];
  const add = (ref: ReportPhotoRef) => {
    const key = reportPhotoKey(ref);
    if (seen.has(key) || refs.length >= MAX_REPORT_PHOTOS) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const block of blocks) if (block.kind === 'gallery') block.photos.forEach((photo) => add(photo.ref));
  for (const block of blocks) {
    if (block.kind === 'entry') block.photos.slice(0, PHOTOS_PER_ENTRY).forEach(add);
  }
  return refs;
}

export async function renderPdf({ templateTitle, agreementName, providerName, clientName, period, packId, snapshotGeneratedAt, editorial, data, activityLines, reportKind, reportScope, status, deliveryChannel, loadPhotos }: ReportRenderInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setLanguage('en-NZ');
  const { normal, bold } = await embedPdfNotoFonts(pdf);
  const reportTitle = typeof editorial.title === 'string' && editorial.title.trim()
    ? editorial.title.trim()
    : `${templateTitle} - ${period}`;
  pdf.setTitle(reportTitle);
  pdf.setSubject(`${agreementName} | ${period}`);
  if (providerName) pdf.setAuthor(providerName);
  pdf.setCreator('Field Compliance Manager');
  // Audit provenance travels in the document properties (and the
  // record_report_pack_pdf row), not on the client's pages.
  pdf.setProducer(rendererVersion);
  pdf.setKeywords([`report-pack:${packId}`, `snapshot-generated:${snapshotGeneratedAt ?? 'not-recorded'}`, `renderer:${rendererVersion}`, `scope:${reportKind}`]);

  const snapshot = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const activityBlocks = reportKind === 'custom' ? null : monthlyActivityBlocks(snapshot, activityLines, { summary: editorial.executive_summary, highlights: editorial.client_notes });
  const logBlocks = activityBlocks ? siteLogBlocks(snapshot, activityLines) : [];
  const photoRefs = entryPhotoRefs([...(activityBlocks ?? []), ...logBlocks]);
  const photoBytes = photoRefs.length && loadPhotos ? await loadPhotos(photoRefs) : new Map<string, Uint8Array>();
  const photos = new Map<string, PDFImage>();
  for (const [key, bytes] of photoBytes) {
    try {
      photos.set(key, await pdf.embedJpg(bytes));
    } catch {
      // An unreadable photo is reported as held on file.
    }
  }

  let page = pdf.addPage(PAGE_SIZE);
  let y = TOP;
  const newPage = () => { page = pdf.addPage(PAGE_SIZE); y = TOP; };
  const ensure = (height: number) => { if (y - height < BOTTOM) newPage(); };
  const drawRuns = (line: string, x: number, baseline: number, fonts: PdfFontPair, size: number, color = INK) => {
    let cursor = x;
    for (const run of pdfTextFontRuns(line, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
      page.drawText(run.text, { x: cursor, y: baseline, size, font: run.font, color });
      cursor += pdfFontTextWidth(run.font, run.text, size);
    }
  };
  const fit = (value: string, fonts: PdfFontPair, size: number, maxWidth: number) => {
    if (textWidth(value, fonts, size) <= maxWidth) return value;
    let characters = Array.from(value);
    while (characters.length && textWidth(`${characters.join('').trimEnd()}…`, fonts, size) > maxWidth) characters = characters.slice(0, -1);
    return `${characters.join('').trimEnd()}…`;
  };
  const draw = (text: string, fonts = normal, size = 10, color = INK) => {
    for (const line of wrapText(text, fonts, size, WIDTH)) {
      ensure(size + 6);
      drawRuns(line, LEFT, y, fonts, size, color);
      y -= size + 6;
    }
  };
  const drawTable = (block: Extract<ReportBlock, { kind: 'table' }>) => {
    const size = block.size ?? 8.5;
    const leading = size + 3;
    const padding = 4;
    ensure(48);
    let top = y + 10;
    const drawRow = (cells: string[], fonts: PdfFontPair, fill: ReturnType<typeof rgb> | null, isHeader: boolean) => {
      const wrapped = block.columns.map((column, index) => wrapText(cells[index] ?? '', fonts, size, column.width - padding * 2));
      const height = Math.max(1, ...wrapped.map((lines) => lines.length)) * leading + padding * 2;
      if (top - height < BOTTOM - 10) {
        newPage();
        top = TOP + 10;
        if (!isHeader) drawRow(block.columns.map((column) => column.label), bold, BRAND_TINT, true);
      }
      if (fill) page.drawRectangle({ x: LEFT, y: top - height, width: WIDTH, height, color: fill });
      let x = LEFT;
      block.columns.forEach((column, index) => {
        wrapped[index].forEach((line, lineIndex) => {
          const baseline = top - padding - size - lineIndex * leading + 1;
          const offset = column.align === 'right' ? column.width - padding - textWidth(line, fonts, size) : padding;
          drawRuns(line, x + offset, baseline, fonts, size, isHeader ? BRAND : INK);
        });
        x += column.width;
      });
      page.drawLine({ start: { x: LEFT, y: top - height }, end: { x: RIGHT, y: top - height }, thickness: isHeader ? 0.8 : 0.3, color: RULE });
      top -= height;
    };
    drawRow(block.columns.map((column) => column.label), bold, BRAND_TINT, true);
    block.rows.forEach((row, index) => drawRow(row, normal, index % 2 ? STRIPE : null, false));
    y = top - 16;
  };
  const drawSection = (title: string) => {
    y -= 10;
    if (y < 160) newPage();
    drawRuns(title, LEFT, y, bold, 13, BRAND);
    y -= 8;
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.8, color: RULE });
    y -= 18;
  };
  const drawSubsection = (title: string, detail = '') => {
    const detailWidth = detail ? textWidth(detail, normal, 8.5) : 0;
    const lines = wrapText(title, bold, 10.5, WIDTH - 24 - detailWidth);
    const height = lines.length * 14 + 10;
    y -= 4;
    if (y - height < 150) newPage();
    page.drawRectangle({ x: LEFT, y: y - height + 10, width: WIDTH, height, color: BRAND_TINT });
    lines.forEach((line, index) => drawRuns(line, LEFT + 8, y - 4 - index * 14, bold, 10.5, BRAND));
    if (detail) drawRuns(detail, RIGHT - 8 - detailWidth, y - 4, normal, 8.5, MUTED);
    y -= height + 8;
  };
  const drawMetrics = (items: Array<{ label: string; value: string }>) => {
    const columns = 4;
    const gap = 8;
    const tileWidth = (WIDTH - gap * (columns - 1)) / columns;
    const tileHeight = 50;
    const rowCount = Math.ceil(items.length / columns);
    ensure(rowCount * (tileHeight + gap));
    items.forEach((item, index) => {
      const x = LEFT + (index % columns) * (tileWidth + gap);
      const top = y + 8 - Math.floor(index / columns) * (tileHeight + gap);
      page.drawRectangle({ x, y: top - tileHeight, width: tileWidth, height: tileHeight, color: BRAND_TINT });
      page.drawRectangle({ x, y: top - tileHeight, width: 3, height: tileHeight, color: BRAND });
      drawRuns(fit(item.value, bold, 17, tileWidth - 16), x + 11, top - 24, bold, 17, BRAND);
      drawRuns(fit(item.label, normal, 8, tileWidth - 16), x + 11, top - 40, normal, 8, MUTED);
    });
    y -= rowCount * (tileHeight + gap) + 6;
  };
  const drawCharts = (block: Extract<ReportBlock, { kind: 'charts' }>) => {
    const gap = 10;
    const cardWidth = (WIDTH - gap) / 2;
    const rowHeight = 14;
    const labelWidth = 80;
    const valueWidth = 28;
    for (let start = 0; start < block.charts.length; start += 2) {
      const charts = block.charts.slice(start, start + 2);
      const rowCount = Math.max(...charts.map((chart) => chart.items.length));
      const height = 25 + rowCount * rowHeight;
      ensure(height + 10);
      const top = y + 6;
      charts.forEach((chart, index) => {
        const x = LEFT + index * (cardWidth + gap);
        page.drawRectangle({ x, y: top - height, width: cardWidth, height, color: STRIPE, borderColor: RULE, borderWidth: 0.5 });
        drawRuns(fit(chart.title, bold, 8.5, cardWidth - 16), x + 8, top - 13, bold, 8.5, BRAND);
        const maxValue = Math.max(1, ...chart.items.map((item) => item.value));
        const trackX = x + 8 + labelWidth + 5;
        const trackWidth = cardWidth - 16 - labelWidth - 5 - valueWidth - 4;
        chart.items.forEach((item, row) => {
          const baseline = top - 28 - row * rowHeight;
          drawRuns(fit(item.label, normal, 7.5, labelWidth), x + 8, baseline, normal, 7.5, INK);
          page.drawRectangle({ x: trackX, y: baseline + 1, width: trackWidth, height: 4, color: BRAND_SOFT });
          page.drawRectangle({ x: trackX, y: baseline + 1, width: trackWidth * Math.min(1, item.value / maxValue), height: 4, color: BRAND });
          const value = new Intl.NumberFormat('en-NZ', { maximumFractionDigits: 0 }).format(item.value);
          drawRuns(value, x + cardWidth - 8 - textWidth(value, normal, 7.5), baseline, normal, 7.5, MUTED);
        });
      });
      y = top - height - 10;
    }
  };
  const drawGallery = (block: Extract<ReportBlock, { kind: 'gallery' }>) => {
    const columns = 3;
    const gap = 10;
    const cellWidth = (WIDTH - gap * (columns - 1)) / columns;
    const maxHeight = 120;
    const shown = block.photos.flatMap((photo) => {
      const image = photos.get(reportPhotoKey(photo.ref));
      if (!image) return [];
      const scale = Math.min(cellWidth / image.width, maxHeight / image.height);
      return [{ image, width: image.width * scale, height: image.height * scale, caption: wrapText(photo.caption, normal, 7.5, cellWidth).slice(0, 2) }];
    });
    for (let start = 0; start < shown.length; start += columns) {
      const row = shown.slice(start, start + columns);
      const imageHeight = Math.max(...row.map((photo) => photo.height));
      const height = imageHeight + 4 + Math.max(...row.map((photo) => photo.caption.length)) * 10;
      ensure(height + 8);
      const top = y + 6;
      row.forEach((photo, index) => {
        const x = LEFT + index * (cellWidth + gap);
        page.drawImage(photo.image, { x, y: top - photo.height, width: photo.width, height: photo.height });
        page.drawRectangle({ x, y: top - photo.height, width: photo.width, height: photo.height, borderColor: RULE, borderWidth: 0.5 });
        photo.caption.forEach((line, lineIndex) => drawRuns(line, x, top - imageHeight - 10 - lineIndex * 10, normal, 7.5, MUTED));
      });
      y = top - height - 10;
    }
    if (shown.length < block.photos.length) {
      draw(`${block.photos.length - shown.length} selected ${block.photos.length - shown.length === 1 ? 'photo is' : 'photos are'} held on file.`, normal, 8, MUTED);
    }
  };
  const drawEntry = (block: Extract<ReportBlock, { kind: 'entry' }>) => {
    const incident = block.tone === 'incident';
    const innerX = LEFT + 12;
    const innerWidth = WIDTH - 20;
    const tagsText = block.tags.join('  ·  ');
    const whenWidth = textWidth(block.when, bold, 8.5);
    const tagsInline = Boolean(tagsText) && whenWidth + 16 + textWidth(tagsText, normal, 8.5) <= innerWidth;
    const tagLines = tagsText && !tagsInline ? wrapText(tagsText, normal, 8.5, innerWidth) : [];
    const titleLines = block.title ? wrapText(block.title, bold, 10, innerWidth) : [];
    const bodies = block.lines.map((line) => ({
      label: line.label ? `${line.label}:` : '',
      lines: wrapText(line.label ? `${line.label}: ${line.text}` : line.text, line.label ? bold : normal, 9.5, innerWidth),
    }));
    const gap = 8;
    const cellWidth = (innerWidth - gap * (PHOTOS_PER_ENTRY - 1)) / PHOTOS_PER_ENTRY;
    const sized = block.photos.slice(0, PHOTOS_PER_ENTRY).flatMap((ref) => {
      const image = photos.get(reportPhotoKey(ref));
      if (!image) return [];
      const scale = Math.min(cellWidth / image.width, 130 / image.height);
      return [{ image, width: image.width * scale, height: image.height * scale }];
    });
    const photoRowHeight = sized.length ? Math.max(...sized.map((photo) => photo.height)) + 12 : 0;
    const held = Math.max(0, block.photoCount - sized.length);
    const heldText = held > 0 ? `${held} ${sized.length ? 'further ' : ''}${held === 1 ? 'photo' : 'photos'} held on file` : '';
    const height = 8 + 11 + tagLines.length * 11 + titleLines.length * 13
      + bodies.reduce((sum, body) => sum + body.lines.length * 13, 0)
      + photoRowHeight + (heldText ? 11 : 0) + 6;
    ensure(Math.min(height, TOP - BOTTOM));
    const top = y + 8;
    if (incident) page.drawRectangle({ x: LEFT, y: top - height, width: WIDTH, height, color: ALERT_TINT });
    page.drawRectangle({ x: LEFT, y: top - height, width: 3, height, color: incident ? ALERT : BRAND });
    let cursor = top - 8 - 8.5;
    drawRuns(block.when, innerX, cursor, bold, 8.5, INK);
    if (tagsInline) drawRuns(tagsText, RIGHT - 8 - textWidth(tagsText, normal, 8.5), cursor, normal, 8.5, MUTED);
    cursor -= 11;
    for (const line of tagLines) { drawRuns(line, innerX, cursor, normal, 8.5, MUTED); cursor -= 11; }
    cursor -= 2;
    for (const line of titleLines) { drawRuns(line, innerX, cursor, bold, 10, incident ? ALERT : INK); cursor -= 13; }
    for (const body of bodies) {
      body.lines.forEach((line, index) => {
        if (index === 0 && body.label && line.startsWith(body.label)) {
          drawRuns(body.label, innerX, cursor, bold, 9.5, INK);
          drawRuns(line.slice(body.label.length), innerX + textWidth(body.label, bold, 9.5), cursor, normal, 9.5, INK);
        } else {
          drawRuns(line, innerX, cursor, normal, 9.5, INK);
        }
        cursor -= 13;
      });
    }
    if (sized.length) {
      const rowTop = cursor + 2;
      sized.forEach((photo, index) => {
        const x = innerX + index * (cellWidth + gap);
        page.drawImage(photo.image, { x, y: rowTop - photo.height, width: photo.width, height: photo.height });
        page.drawRectangle({ x, y: rowTop - photo.height, width: photo.width, height: photo.height, borderColor: RULE, borderWidth: 0.5 });
      });
      cursor -= photoRowHeight;
    }
    if (heldText) drawRuns(heldText, innerX, cursor, normal, 8, MUTED);
    if (!incident) page.drawLine({ start: { x: LEFT, y: top - height }, end: { x: RIGHT, y: top - height }, thickness: 0.3, color: RULE });
    y = top - height - 16;
  };
  const drawBlocks = (blocks: ReportBlock[]) => {
    for (const block of blocks) {
      if (block.kind === 'section') drawSection(block.title);
      else if (block.kind === 'subsection') drawSubsection(block.title, block.detail);
      else if (block.kind === 'table') drawTable(block);
      else if (block.kind === 'metrics') drawMetrics(block.items);
      else if (block.kind === 'charts') drawCharts(block);
      else if (block.kind === 'gallery') drawGallery(block);
      else if (block.kind === 'entry') drawEntry(block);
      else { draw(block.text, block.bold ? bold : normal, block.size ?? 10, block.muted ? MUTED : INK); y -= 2; }
    }
  };
  const drawMonthlySections = () => {
    const number = (key: string) => typeof snapshot[key] === 'number' ? snapshot[key] as number : null;
    const format = (value: number | null, maximumFractionDigits = 0) => value === null
      ? 'Not recorded'
      : new Intl.NumberFormat('en-NZ', { maximumFractionDigits }).format(value);

    if (!activityBlocks && typeof editorial.executive_summary === 'string' && editorial.executive_summary) {
      drawSection('Overview');
      draw(editorial.executive_summary);
    }
    if (!activityBlocks && typeof editorial.client_notes === 'string' && editorial.client_notes) {
      drawSection('Highlights');
      draw(editorial.client_notes);
    }

    if (activityBlocks) {
      drawBlocks(activityBlocks);
    } else {
      drawSection('Patrol and Activity Summary');
      draw(`Patrol visits: ${format(number('patrolVisits'))}`);
      draw(`Camera activations: ${format(number('cameraActivations'))}`);
      draw(`Vehicle observations: ${format(number('vehicleObservations'))}`);
    }

    const facilities = Array.isArray(snapshot.facilities)
      ? snapshot.facilities.filter((value): value is Record<string, unknown> => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const facility = value as Record<string, unknown>;
        const expected = typeof facility.expected === 'number' ? facility.expected : 0;
        const completed = typeof facility.completed === 'number' ? facility.completed : 0;
        return expected !== 0 || completed !== 0;
      })
      : [];
    if (facilities.length) {
      drawSection('Site Coverage');
      drawTable({
        kind: 'table',
        columns: [{ label: 'Location', width: 287 }, { label: 'Planned', width: 100, align: 'right' }, { label: 'Completed', width: 100, align: 'right' }],
        rows: facilities.map((facility) => [
          typeof facility.siteName === 'string' ? facility.siteName : 'Unnamed location',
          format(typeof facility.expected === 'number' ? facility.expected : null),
          format(typeof facility.completed === 'number' ? facility.completed : null),
        ]),
      });
    }

    const sla: Array<[string, number | null]> = [['Met', number('slaMet')], ['Breached', number('slaBreached')], ['In progress', number('slaRunning')]];
    if (sla.some(([, value]) => (value ?? 0) > 0)) {
      drawSection('Service Level Performance');
      drawTable({
        kind: 'table',
        columns: [{ label: 'Service level', width: 387 }, { label: 'Count', width: 100, align: 'right' }],
        rows: sla.map(([label, value]) => [label, format(value)]),
      });
    }

    if (typeof editorial.follow_up === 'string' && editorial.follow_up) {
      drawSection('Follow-up');
      draw(editorial.follow_up);
    }

    drawBlocks(logBlocks);
  };
  const drawCover = () => {
    const titleLines = wrapText(reportTitle, bold, 20, WIDTH).slice(0, 3);
    const bandHeight = 40 + (providerName ? 22 : 0) + titleLines.length * 25;
    page.drawRectangle({ x: 0, y: PAGE_SIZE[1] - bandHeight, width: PAGE_SIZE[0], height: bandHeight, color: BRAND });
    let baseline = PAGE_SIZE[1] - 30;
    if (providerName) {
      drawRuns(fit(providerName.toUpperCase(), bold, 9, WIDTH), LEFT, baseline, bold, 9, BRAND_SOFT);
      baseline -= 26;
    }
    for (const line of titleLines) {
      drawRuns(line, LEFT, baseline, bold, 20, WHITE);
      baseline -= 25;
    }
    y = PAGE_SIZE[1] - bandHeight - 26;
    const facts: Array<[string, string]> = [];
    if (clientName) facts.push(['Prepared for', clientName]);
    facts.push(['Agreement', agreementName], ['Reporting period', period]);
    const prepared = preparedDate(snapshotGeneratedAt);
    if (prepared) facts.push(['Prepared', prepared]);
    for (const [label, value] of facts) {
      const lines = wrapText(value, normal, 10, WIDTH - 110);
      drawRuns(label, LEFT, y, bold, 8.5, MUTED);
      lines.forEach((line, index) => drawRuns(line, LEFT + 110, y - index * 14, normal, 10, INK));
      y -= lines.length * 14 + 4;
    }
    if (status === 'draft') {
      y -= 6;
      page.drawRectangle({ x: LEFT, y: y - 8, width: WIDTH, height: 24, color: ALERT_TINT });
      drawRuns('Draft for provider review. This report has not been issued.', LEFT + 10, y, bold, 9, ALERT);
      y -= 24;
    }
    y -= 6;
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1.2, color: BRAND });
    y -= 12;
  };

  drawCover();
  if (reportKind === 'custom') {
    drawSection('Frozen report scope');
    for (const line of customScopeLines(reportScope)) draw(line);
    if (typeof editorial.executive_summary === 'string' && editorial.executive_summary) { drawSection('Executive summary'); draw(editorial.executive_summary); }
    if (typeof editorial.client_notes === 'string' && editorial.client_notes) { drawSection('Client notes'); draw(editorial.client_notes); }
    if (typeof editorial.follow_up === 'string' && editorial.follow_up) { drawSection('Follow-up'); draw(editorial.follow_up); }
    drawSection('Source-derived metrics');
    for (const line of flatten(data)) draw(line);
    y -= 6;
    draw(availabilityLine(status, deliveryChannel), normal, 8, MUTED);
  } else {
    drawMonthlySections();
  }

  const pages = pdf.getPages();
  const reference = `Ref ${packId.slice(0, 8).toUpperCase()}`;
  pages.forEach((current, index) => {
    page = current;
    page.drawLine({ start: { x: LEFT, y: 46 }, end: { x: RIGHT, y: 46 }, thickness: 0.5, color: RULE });
    const right = `${reference}  ·  Page ${index + 1} of ${pages.length}`;
    const rightWidth = textWidth(right, normal, 7.5);
    drawRuns(fit(`${agreementName}  ·  ${period}`, normal, 7.5, WIDTH - rightWidth - 24), LEFT, 34, normal, 7.5, MUTED);
    drawRuns(right, RIGHT - rightWidth, 34, normal, 7.5, MUTED);
    if (status === 'draft') page.drawText('DRAFT', { x: 150, y: 300, size: 120, font: bold.latin, color: ALERT, opacity: 0.06, rotate: degrees(35) });
  });
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
  const { data: pack, error: packError } = await admin.from('monthly_report_packs').select('id,organization_id,period_start,period_end,template_code,status,data,activity_lines,editorial,generated_at,report_kind,report_scope,updated_at,pdf_path,delivery_channel,agreement:service_agreement_id(name,client:client_organization_id(name)),provider:organization_id(name)').eq('id', packId).single();
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
  const { data: template } = await admin.from('report_templates').select('name')
    .eq('organization_id', pack.organization_id).eq('template_code', pack.template_code).maybeSingle();
  const templateTitle = typeof template?.name === 'string' && template.name.trim()
    ? template.name.trim()
    : pack.report_kind === 'custom' ? 'Custom report' : `${pack.template_code.replaceAll('_', ' ')} report`;
  const bytes = await renderPdf({
    templateTitle,
    agreementName: reportAgreementName(pack),
    providerName: relationName(pack.provider),
    clientName: reportClientName(pack),
    period: reportPeriodLabel(pack.period_start, pack.period_end),
    packId: pack.id,
    snapshotGeneratedAt: pack.generated_at,
    editorial: pack.editorial ?? {},
    data: pack.data ?? {},
    activityLines: pack.activity_lines ?? null,
    reportKind: pack.report_kind ?? 'monthly',
    reportScope: pack.report_scope ?? {},
    status: pack.status,
    deliveryChannel: pack.delivery_channel,
    loadPhotos: (refs) => loadReportPhotos(admin, refs),
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
