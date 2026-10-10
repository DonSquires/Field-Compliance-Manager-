/**
 * generate-noise-evidence-package -- Court-ready noise control evidence package
 *
 * Generates a REAL PDF (application/pdf) using pdf-lib, containing all 10
 * required sections of a noise control evidence package:
 *   1. Original complaint
 *   2. Dispatch record
 *   3. GPS track
 *   4. Three-address record
 *   5. H&S checklist
 *   6. Photographs (embedded)
 *   7. Matrix score breakdown
 *   8. Issued notices (via notice_templates when available)
 *   9. Seizure record
 *  10. Incident report
 *
 * Stores the PDF in the notice-artifacts Storage bucket and writes the URL
 * to noise_assessments.evidence_package_url.
 *
 * Input (POST JSON):
 *   assessment_id  -- UUID of the noise_assessments row
 *
 * Output:
 *   { ok: true, evidence_package_url: string }
 *
 * Issue #60. Uses pdf-lib@1.17.1 (pure TypeScript, Deno-compatible).
 */ import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { embedPdfNotoFonts } from "../_shared/pdf-noto-fonts.ts";
import { pdfTextFontRuns, pdfTextWidth, wrapPdfText, type PdfTextFontPair } from "../_shared/pdf-text-fonts.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const PDF_RENDERER_VERSION = "fcm-noise-evidence-pdf-lib-a4-v5";
type NoiseSupabaseClient = ReturnType<typeof createClient<any>>;
interface NoisePhotoEntry {
  storage_path?: string;
  name?: string;
}
interface NoiseSeizure {
  item_description?: string | null;
  police_present?: boolean | null;
  police_name?: string | null;
  seizure_form_number?: string | null;
  photo_urls?: NoisePhotoEntry[] | null;
  legal_authority?: string | null;
  seized_at?: string | null;
  make?: string | null;
  model?: string | null;
  serial_number?: string | null;
}
interface NoiseAssessment {
  id: string;
  organization_id: string;
  job_number?: string | null;
  action?: string | null;
  received_at?: string | null;
  assessed_at?: string | null;
  arrived_at?: string | null;
  departed_at?: string | null;
  officer_name?: string | null;
  volume_score?: number | null;
  time_score?: number | null;
  tone_score?: number | null;
  matrix_total?: number | null;
  is_problem_address?: boolean | null;
  occupant_cooperative?: boolean | null;
  prior_end_within_72hrs?: boolean | null;
  permanent_abatement_active?: boolean | null;
  police_requested?: boolean | null;
  police_present?: boolean | null;
  end_number?: string | null;
    end_expires_at?: string | null;
    end_given_orally?: boolean | null;
    end_recipient_role?: string | null;
    entry_notice_left?: boolean | null;
  occupant_name?: string | null;
  complaint_address?: string | null;
  assessment_location?: string | null;
  assessment_gps_lat?: number | null;
  assessment_gps_lng?: number | null;
  assessment_gps_accuracy?: number | null;
  noise_source_address?: string | null;
  arrival_gps_lat?: number | null;
  arrival_gps_lng?: number | null;
  arrival_gps_accuracy?: number | null;
  address_discrepancy_noted?: boolean | null;
  address_discrepancy_reason?: string | null;
  hs_checklist_completed?: boolean | null;
  hs_checklist_items?: unknown;
  hs_abort_reason?: string | null;
  photo_assessment_point?: NoisePhotoEntry[] | null;
  photo_source_address?: NoisePhotoEntry[] | null;
  photo_service_evidence?: NoisePhotoEntry[] | null;
  incident_report_text?: string | null;
  notes?: string | null;
  follow_up_required?: boolean | null;
  complainant_protected?: boolean | null;
  client_sites?: { name?: string | null; address?: string | null } | { name?: string | null; address?: string | null }[] | null;
}
interface NoisePdfContext {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  fontNormal: PdfTextFontPair<PDFFont>;
  fontBold: PdfTextFontPair<PDFFont>;
}
/* ---- Layout constants (A4 in points: 595 x 842) ---- */ const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const LINE_HEIGHT = 14;
const SECTION_GAP = 20;
const PHOTO_MAX_W = 240;
const PHOTO_MAX_H = 180;
function ensureSpace(ctx: NoisePdfContext, needed: number): NoisePdfContext {
  if (ctx.y - needed < MARGIN) {
    const newPage = ctx.doc.addPage([
      PAGE_W,
      PAGE_H
    ]);
    ctx.page = newPage;
    ctx.y = PAGE_H - MARGIN;
  }
  return ctx;
}
function drawPdfRuns(page: PDFPage, text: string, fonts: PdfTextFontPair<PDFFont>, size: number, x: number, y: number, color: ReturnType<typeof rgb>): number {
  let drawX = x;
  for (const run of pdfTextFontRuns(text, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)) {
    page.drawText(run.text, { x: drawX, y, size, font: run.font, color });
    drawX += run.font.widthOfTextAtSize(run.text, size);
  }
  return drawX - x;
}
function drawPdfText(ctx: NoisePdfContext, text: string, fonts: PdfTextFontPair<PDFFont>, size: number, x = MARGIN, maxWidth = CONTENT_W): NoisePdfContext {
  for (const line of wrapPdfText(text, fonts, size, maxWidth)) {
    ctx = ensureSpace(ctx, LINE_HEIGHT);
    drawPdfRuns(ctx.page, line, fonts, size, x, ctx.y, rgb(0, 0, 0));
    ctx.y -= LINE_HEIGHT;
  }
  return ctx;
}
function drawSectionTitle(ctx: NoisePdfContext, title: string): NoisePdfContext {
  ctx = ensureSpace(ctx, SECTION_GAP + LINE_HEIGHT * 2);
  ctx.y -= SECTION_GAP;
  ctx.page.drawLine({
    start: {
      x: MARGIN,
      y: ctx.y
    },
    end: {
      x: PAGE_W - MARGIN,
      y: ctx.y
    },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6)
  });
  ctx.y -= LINE_HEIGHT + 2;
  return drawPdfText(ctx, title, ctx.fontBold, 12);
}
function drawField(ctx: NoisePdfContext, label: string, value: string): NoisePdfContext {
  ctx = ensureSpace(ctx, LINE_HEIGHT);
  drawPdfRuns(ctx.page, `${label}:`, ctx.fontBold, 9, MARGIN, ctx.y, rgb(0.3, 0.3, 0.3));
  ctx = drawPdfText(ctx, value || "N/A", ctx.fontNormal, 9, MARGIN + 140, CONTENT_W - 140);
  return ctx;
}
function wrapText(text: string, maxChars: number): string[] {
  if (!text) return [
    "N/A"
  ];
  const lines = [];
  // Split on existing newlines first
  const rawLines = text.split("\n");
  for (const rawLine of rawLines){
    if (rawLine.length <= maxChars) {
      lines.push(rawLine);
    } else {
      let remaining = rawLine;
      while(remaining.length > maxChars){
        let breakAt = remaining.lastIndexOf(" ", maxChars);
        if (breakAt <= 0) breakAt = maxChars;
        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) lines.push(remaining);
    }
  }
  return lines.length > 0 ? lines : [
    "N/A"
  ];
}
function drawWrappedText(ctx: NoisePdfContext, text: string, fontSize = 9): NoisePdfContext {
  return drawPdfText(ctx, text, ctx.fontNormal, fontSize);
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return "N/A";
  try {
    return new Date(d).toLocaleString("en-NZ", {
      timeZone: "Pacific/Auckland",
      dateStyle: "long",
      timeStyle: "short"
    });
  } catch  {
    return d;
  }
}
function fmtDuration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return "N/A";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "0 minutes";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}
async function embedPhoto(ctx: NoisePdfContext, supabase: NoiseSupabaseClient, photoEntry: NoisePhotoEntry | null | undefined, label: string): Promise<NoisePdfContext> {
  if (!photoEntry?.storage_path) return ctx;
  try {
    // Get a signed URL for the photo
    const { data: signedData, error: signErr } = await supabase.storage.from("evidence-photos").createSignedUrl(photoEntry.storage_path, 300);
    if (signErr || !signedData?.signedUrl) {
      ctx = drawField(ctx, label, `[Photo unavailable: ${signErr?.message ?? "no URL"}]`);
      return ctx;
    }
    const response = await fetch(signedData.signedUrl);
    if (!response.ok) {
      ctx = drawField(ctx, label, "[Photo could not be fetched]");
      return ctx;
    }
    const imageBytes = new Uint8Array(await response.arrayBuffer());
    if (imageBytes.length < 10) {
      ctx = drawField(ctx, label, "[Photo file empty]");
      return ctx;
    }
    // Detect format from magic bytes
    let embeddedImage;
    const isJpeg = imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff;
    const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4e && imageBytes[3] === 0x47;
    if (isJpeg) {
      embeddedImage = await ctx.doc.embedJpg(imageBytes);
    } else if (isPng) {
      embeddedImage = await ctx.doc.embedPng(imageBytes);
    } else {
      ctx = drawField(ctx, label, "[Unsupported image format]");
      return ctx;
    }
    // Scale to fit
    const scale = Math.min(PHOTO_MAX_W / embeddedImage.width, PHOTO_MAX_H / embeddedImage.height, 1);
    const drawW = embeddedImage.width * scale;
    const drawH = embeddedImage.height * scale;
    // Label
    ctx = ensureSpace(ctx, drawH + LINE_HEIGHT + 4);
    drawPdfRuns(ctx.page, label, ctx.fontBold, 8, MARGIN, ctx.y, rgb(0.3, 0.3, 0.3));
    ctx.y -= 2;
    // Image
    ctx.page.drawImage(embeddedImage, {
      x: MARGIN,
      y: ctx.y - drawH,
      width: drawW,
      height: drawH
    });
    ctx.y -= drawH + 6;
    // Photo name caption
    if (photoEntry.name) {
      ctx = drawPdfText(ctx, photoEntry.name, ctx.fontNormal, 7);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx = drawField(ctx, label, `[Photo embed error: ${msg}]`);
  }
  return ctx;
}
/* ---- Notice template rendering ---- */ function renderTemplateText(bodyHtml: string, vars: Record<string, string>): string {
  // Strip HTML tags for plain-text PDF rendering
  let text = bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n").replace(/<\/tr>/gi, "\n").replace(/<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Replace {{variable}} placeholders
  for (const [key, val] of Object.entries(vars)){
    text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
  }
  return text.trim();
}
/* ---- Default RMA citation content (fallback when no notice_templates row) ---- */ function defaultEndNoticeText(assessment: NoiseAssessment): string {
  const endNum = assessment.end_number ?? "N/A";
  const occupant = assessment.occupant_name ?? "N/A";
  const address = assessment.noise_source_address ?? assessment.assessment_location ?? "N/A";
  const assessedAt = fmtDate(assessment.assessed_at);
  const expiry = assessment.end_expires_at ? fmtDate(assessment.end_expires_at) : "Not recorded - verify before serving";
  const delivery = assessment.end_given_orally === true ? "Orally" : assessment.end_given_orally === false ? "In writing" : "Not recorded";
  const recipient = assessment.end_recipient_role ?? "Not recorded";
  return [
    "EXCESSIVE NOISE DIRECTION (END)",
    `END Number: ${endNum}`,
    `Issued to: ${occupant}`,
    `Address: ${address}`,
    `Assessment Date/Time (direction issue time not separately recorded): ${assessedAt}`,
    `Direction given: ${delivery}`,
    `Direction recipient: ${recipient}`,
    `Recorded expiry: ${expiry}`,
    "",
    "Legislative Authority: Resource Management Act 1991, Section 326",
    "",
    "You are hereby directed to immediately reduce the noise emanating from",
    "the above address to a reasonable level.",
    "",
    "RMA section 327(3) permits a direction for up to 8 days, or a shorter period set by the council rule or officer. The recorded expiry above governs this assessment.",
    "",
    "Contravening an excessive noise direction is an offence under RMA section 338(2).",
    "The maximum fine is $10,000 plus up to $1,000 for each continuing day.",
    "Seizure is governed by RMA section 328 and its constable-attendance requirements.",
    "",
    "An owner may apply for return of seized property at any time under RMA section 336, subject to its return conditions and applicable costs."
  ].join("\n");
}
function defaultSeizureNoticeText(assessment: NoiseAssessment, seizure: NoiseSeizure | null): string {
  const endNum = assessment.end_number ?? "N/A";
  const occupant = assessment.occupant_name ?? "N/A";
  const address = assessment.noise_source_address ?? assessment.assessment_location ?? "N/A";
  const items = seizure?.item_description ?? "N/A";
  const policeOfficer = seizure?.police_name ?? "N/A";
  const formNum = seizure?.seizure_form_number ?? "N/A";
  return [
    "EQUIPMENT SEIZURE NOTICE",
    `Related END Number: ${endNum}`,
    `Occupant: ${occupant}`,
    `Address: ${address}`,
    "",
    "Legislative Authority: Resource Management Act 1991, Section 328",
    "",
    "The following equipment has been seized under s.328 of the RMA 1991",
    "with the required constable attendance:",
    "",
    `Items seized: ${items}`,
    `Seizure form number: ${formNum}`,
    `Police officer present: ${policeOfficer}`,
    "",
    "An owner may apply for return of seized property at any time under RMA section 336, subject to the statutory return conditions and applicable costs.",
    "Contravention of an excessive noise direction may carry a fine up to $10,000, plus up to $1,000 for each continuing day (RMA section 338(2))."
  ].join("\n");
}
/* ---- Volume/Time/Tone labels ---- */ const VOLUME_LABELS: Record<number, string> = {
  0: "No Noise",
  1: "Barely Audible",
  2: "Clearly Audible",
  3: "Loud",
  4: "Extremely Loud"
};
const TIME_LABELS: Record<number, string> = {
  1: "7am-9pm",
  2: "9pm-midnight",
  3: "midnight-2am",
  4: "2am-7am"
};
const TONE_LABELS: Record<number, string> = {
  0: "No bass",
  1: "Slight bass",
  2: "Heavy bass"
};
const HS_ITEMS = [
  "Phone is fully charged",
  "Risk assessment completed for this address",
  "Access and exit routes identified",
  "Vehicle parked for quick unobstructed departure",
  "Body Worn Camera activated on arrival"
];
/* ==== Main handler ==== */ serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    // Auth
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: corsHeaders
    });
    const { data: profile } = await supabase.from("user_profiles").select("id, deactivated_at").eq("id", user.id).maybeSingle();
    if (!profile || profile.deactivated_at) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders });
    const body = await req.json();
    const { assessment_id } = body;
    if (!assessment_id) return new Response(JSON.stringify({
      error: "assessment_id is required"
    }), {
      status: 400,
      headers: corsHeaders
    });
    // ---- Load assessment ----
    const { data: assessmentRow, error: assessErr } = await supabase.from("noise_assessments").select(`id, organization_id, job_number, site_id, status, action,
         received_at, arrived_at, departed_at, created_at,
                 received_at, assessed_at, arrived_at, departed_at, created_at,
         officer_id, officer_name,
         volume_score, time_score, tone_score, matrix_total,
         visit_number_tonight, is_problem_address, occupant_cooperative,
         prior_end_within_72hrs, permanent_abatement_active,
         police_requested, police_present,
         end_number, occupant_name,
                 end_number, end_expires_at, end_given_orally, end_recipient_role, entry_notice_left, occupant_name,
         complaint_address,
         assessment_location, assessment_gps_lat, assessment_gps_lng, assessment_gps_accuracy,
         noise_source_address, noise_source_gps_lat, noise_source_gps_lng,
         arrival_gps_lat, arrival_gps_lng, arrival_gps_accuracy,
         address_discrepancy_noted, address_discrepancy_reason,
         hs_checklist_completed, hs_checklist_items, hs_abort_reason,
         photo_assessment_point, photo_source_address, photo_service_evidence,
         incident_report_text, notes, follow_up_required,
         complainant_protected, referred_animal_control,
         evidence_package_url,
         client_sites(name, address)`).eq("id", assessment_id).single();
    if (assessErr || !assessmentRow) return new Response(JSON.stringify({
      error: `Assessment not found: ${assessErr?.message ?? "no data"}`
    }), {
      status: 404,
      headers: corsHeaders
    });
    const assessment = assessmentRow as unknown as NoiseAssessment;
    const { data: mayGenerate, error: accessErr } = await caller.rpc("is_admin_for_org", { target_org_id: assessment.organization_id });
    if (accessErr) return new Response(JSON.stringify({ error: "Noise evidence access could not be confirmed" }), { status: 503, headers: corsHeaders });
    if (mayGenerate !== true) return new Response(JSON.stringify({ error: "Assessment not found" }), { status: 404, headers: corsHeaders });
    // ---- Load org ----
    const { data: org } = await supabase.from("organizations").select("name, contact_email, contact_phone, logo_url").eq("id", assessment.organization_id).single();
    const orgName = org?.name ?? "Iron Eagle Field Services";
    // ---- Load seizure record (if any) ----
    const { data: seizureRow } = await supabase.from("noise_seizures").select("id, item_description, police_present, police_name, seizure_form_number, photo_urls, legal_authority, seized_at, make, model, serial_number").eq("noise_assessment_id", assessment_id).maybeSingle();
    const seizure = seizureRow as NoiseSeizure | null;
    // ---- Load notice template (for END or seizure) ----
    const noticeType = assessment.action === "seizure" ? "seizure" : "end";
    const { data: template } = await supabase.from("notice_templates").select("*").eq("organization_id", assessment.organization_id).eq("notice_type", noticeType).eq("is_active", true).order("version", {
      ascending: false
    }).limit(1).maybeSingle();
    // ---- Build PDF ----
    const pdfDoc = await PDFDocument.create();
    const { normal: fontNormal, bold: fontBold } = await embedPdfNotoFonts(pdfDoc);
    const page = pdfDoc.addPage([
      PAGE_W,
      PAGE_H
    ]);
    let ctx = {
      doc: pdfDoc,
      page,
      y: PAGE_H - MARGIN,
      fontNormal,
      fontBold
    };
    const clientSite = Array.isArray(assessment.client_sites) ? assessment.client_sites[0] : assessment.client_sites;
    const siteAddress = clientSite?.address ?? "N/A";
    const jobNumber = assessment.job_number ?? "N/A";
    const generatedAt = new Date().toLocaleString("en-NZ", {
      timeZone: "Pacific/Auckland",
      dateStyle: "long",
      timeStyle: "short"
    });
    pdfDoc.setTitle(`Noise Control Evidence Package - ${jobNumber}`);
    pdfDoc.setAuthor(orgName);
    pdfDoc.setSubject(`Noise control evidence for job ${jobNumber}`);
    pdfDoc.setCreator("Field Compliance Manager");
    pdfDoc.setLanguage("en-NZ");
    // ---- Title / Header ----
    ctx = drawPdfText(ctx, orgName, fontBold, 16);
    ctx = drawPdfText(ctx, "NOISE CONTROL EVIDENCE PACKAGE", fontBold, 14);
    ctx = drawPdfText(ctx, "Court-Ready Evidence Bundle", fontNormal, 10);
    ctx.page.drawLine({
      start: {
        x: MARGIN,
        y: ctx.y
      },
      end: {
        x: PAGE_W - MARGIN,
        y: ctx.y
      },
      thickness: 2,
      color: rgb(0.13, 0.13, 0.6)
    });
    ctx.y -= LINE_HEIGHT;
    ctx = drawField(ctx, "Job Number", jobNumber);
    ctx = drawField(ctx, "Generated", generatedAt);
    ctx = drawField(ctx, "Officer", assessment.officer_name ?? "N/A");
    // ---- Section 1: Original Complaint ----
    // #159: use complaint_address (complainant's property) when available
    const complaintAddr = assessment.complaint_address ?? siteAddress;
    ctx = drawSectionTitle(ctx, "1. ORIGINAL COMPLAINT");
    ctx = drawField(ctx, "Complaint Address", complaintAddr);
    ctx = drawField(ctx, "Time Received", fmtDate(assessment.received_at));
    ctx = drawField(ctx, "Dispatcher", "N/A");
    if (assessment.complainant_protected) {
      ctx = drawField(ctx, "Complainant", "PROTECTED - identity not disclosed");
    }
    // ---- Section 2: Dispatch Record ----
    ctx = drawSectionTitle(ctx, "2. DISPATCH RECORD");
    ctx = drawField(ctx, "Officer Assigned", assessment.officer_name ?? "N/A");
    ctx = drawField(ctx, "Time Dispatched", fmtDate(assessment.received_at));
    ctx = drawField(ctx, "Time Arrived", fmtDate(assessment.arrived_at));
    const responseTime = assessment.received_at && assessment.arrived_at ? fmtDuration(assessment.received_at, assessment.arrived_at) : "N/A";
    ctx = drawField(ctx, "Response Time", responseTime);
    // ---- Section 3: GPS Track ----
    ctx = drawSectionTitle(ctx, "3. GPS TRACK");
    ctx = drawField(ctx, "Arrival GPS", assessment.arrival_gps_lat != null ? `${Number(assessment.arrival_gps_lat).toFixed(6)}, ${Number(assessment.arrival_gps_lng).toFixed(6)} (±${Number(assessment.arrival_gps_accuracy ?? 0).toFixed(0)}m)` : "Not captured");
    ctx = drawField(ctx, "Assessment GPS", assessment.assessment_gps_lat != null ? `${Number(assessment.assessment_gps_lat).toFixed(6)}, ${Number(assessment.assessment_gps_lng).toFixed(6)} (±${Number(assessment.assessment_gps_accuracy ?? 0).toFixed(0)}m)` : "Not captured");
    ctx = drawField(ctx, "Arrival Time", fmtDate(assessment.arrived_at));
    ctx = drawField(ctx, "Assessment Time", fmtDate(assessment.arrived_at));
    // ---- Section 4: Three-Address Record (#159: dual-address model) ----
    const noiseSourceAddr = assessment.noise_source_address ?? siteAddress;
    ctx = drawSectionTitle(ctx, "4. THREE-ADDRESS RECORD");
    ctx = drawField(ctx, "Complaint Address", complaintAddr);
    ctx = drawField(ctx, "Noise Source Address", noiseSourceAddr);
    ctx = drawField(ctx, "Assessment Location", assessment.assessment_location ?? noiseSourceAddr);
    if (assessment.address_discrepancy_noted) {
      ctx = drawField(ctx, "Address Discrepancy", assessment.address_discrepancy_reason ?? "Noted - addresses differ");
    }
    if (complaintAddr !== noiseSourceAddr) {
      ctx = drawField(ctx, "Note", "Complaint address and noise source address differ. Site entity (site_id) is anchored to the noise source address.");
    }
    // ---- Section 5: H&S Checklist ----
    ctx = drawSectionTitle(ctx, "5. HEALTH & SAFETY CHECKLIST");
    ctx = drawField(ctx, "Checklist Completed", assessment.hs_checklist_completed ? "Yes" : "No");
    const hsItems = assessment.hs_checklist_items;
    if (Array.isArray(hsItems)) {
      for(let i = 0; i < HS_ITEMS.length; i++){
        const checked = hsItems[i] === true;
        ctx = drawField(ctx, `Item ${i + 1}`, `${checked ? "[X]" : "[ ]"} ${HS_ITEMS[i]}`);
      }
    }
    if (assessment.hs_abort_reason) {
      ctx = drawField(ctx, "Abort Reason", assessment.hs_abort_reason);
    }
    // ---- Section 6: Photographs ----
    ctx = drawSectionTitle(ctx, "6. PHOTOGRAPHS");
    const assessmentPhotos = assessment.photo_assessment_point ?? [];
    const sourcePhotos = assessment.photo_source_address ?? [];
    const servicePhotos = assessment.photo_service_evidence ?? [];
    if (assessmentPhotos.length === 0 && sourcePhotos.length === 0 && servicePhotos.length === 0) {
      ctx = drawField(ctx, "Photos", "No photographs attached");
    } else {
      for(let i = 0; i < assessmentPhotos.length; i++){
        ctx = await embedPhoto(ctx, supabase, assessmentPhotos[i], `Assessment Point Photo ${i + 1}`);
      }
      for(let i = 0; i < sourcePhotos.length; i++){
        ctx = await embedPhoto(ctx, supabase, sourcePhotos[i], `Source Address Photo ${i + 1}`);
      }
      for(let i = 0; i < servicePhotos.length; i++){
        ctx = await embedPhoto(ctx, supabase, servicePhotos[i], `Service Evidence Photo ${i + 1}`);
      }
    }
    // Seizure photos (from noise_seizures)
    if (seizure) {
      const seizurePhotos = seizure.photo_urls ?? [];
      for(let i = 0; i < seizurePhotos.length; i++){
        ctx = await embedPhoto(ctx, supabase, seizurePhotos[i], `Seized Equipment Photo ${i + 1}`);
      }
    }
    // ---- Section 7: Matrix Score Breakdown ----
    ctx = drawSectionTitle(ctx, "7. TDC MATRIX SCORE BREAKDOWN");
    const vol = assessment.volume_score;
    const tim = assessment.time_score;
    const ton = assessment.tone_score;
    const total = assessment.matrix_total;
    ctx = drawField(ctx, "Volume", vol != null ? `${vol} - ${VOLUME_LABELS[vol] ?? "Unknown"}` : "N/A");
    ctx = drawField(ctx, "Time of Day", vol === 0 ? "N/A (Volume is 0)" : tim != null ? `${tim} - ${TIME_LABELS[tim] ?? "Unknown"}` : "N/A");
    ctx = drawField(ctx, "Tone / Bass", ton != null ? `${ton} - ${TONE_LABELS[ton] ?? "Unknown"}` : "N/A");
    ctx = drawField(ctx, "Matrix Total", String(total ?? 0));
    const assessmentLabel = total == null || total === 0 ? "No Noise" : total < 5 ? "Acceptable" : "Excessive Noise";
    ctx = drawField(ctx, "Assessment", assessmentLabel);
    const actionLabels: Record<string, string> = {
      no_noise: "No Noise - no further action",
      acceptable: "Noise acceptable - no further action",
      verbal_warning: "Verbal Warning issued",
      end: "Excessive Noise Direction (END) issued",
      seizure: "Equipment seized - police present"
    };
    ctx = drawField(ctx, "Action Taken", actionLabels[assessment.action ?? ""] ?? assessment.action ?? "N/A");
    // ---- Section 8: Issued Notices ----
    ctx = drawSectionTitle(ctx, "8. ISSUED NOTICES");
    if (assessment.action === "end" || assessment.action === "seizure") {
      ctx = drawField(ctx, "END Number", assessment.end_number ?? "N/A");
      ctx = drawField(ctx, "Occupant Name", assessment.occupant_name ?? "N/A");
      ctx = drawField(ctx, "Time Issued", fmtDate(assessment.arrived_at));
        ctx = drawField(ctx, "Assessment Time", fmtDate(assessment.assessed_at));
        if (assessment.end_given_orally != null) ctx = drawField(ctx, "Direction Given", assessment.end_given_orally ? "Orally" : "In writing");
        if (assessment.end_recipient_role) ctx = drawField(ctx, "Direction Recipient", assessment.end_recipient_role);
        if (assessment.end_expires_at) ctx = drawField(ctx, "Direction Expires", fmtDate(assessment.end_expires_at));
        if (assessment.entry_notice_left) ctx = drawField(ctx, "Entry Notice", "Written direction and entry notice left at the unoccupied place");
      ctx = drawField(ctx, "Legislative Authority", "Resource Management Act 1991 s.326/s.327");
      // Render notice content from template or fallback
      ctx.y -= 6;
      let noticeText;
      if (template?.body_html) {
        const vars = {
          end_number: assessment.end_number ?? "",
          occupant: assessment.occupant_name ?? "",
          address: assessment.noise_source_address ?? assessment.assessment_location ?? siteAddress,
          date: fmtDate(assessment.arrived_at),
          officer: assessment.officer_name ?? "",
          org_name: orgName,
          job_number: jobNumber
        };
        noticeText = renderTemplateText(template.body_html, vars);
      } else if (assessment.action === "seizure") {
        noticeText = defaultSeizureNoticeText(assessment, seizure);
      } else {
        noticeText = defaultEndNoticeText(assessment);
      }
      ctx = drawWrappedText(ctx, noticeText);
    } else if (assessment.action === "verbal_warning") {
      ctx = drawField(ctx, "Notice Type", "Verbal Warning");
      ctx = drawField(ctx, "Notes", assessment.notes ?? "N/A");
    } else {
      ctx = drawField(ctx, "Notices", "No notices issued (noise level acceptable or not present)");
    }
    // ---- Section 9: Seizure Record ----
    ctx = drawSectionTitle(ctx, "9. SEIZURE RECORD");
    if (seizure) {
      ctx = drawField(ctx, "Items Seized", seizure.item_description ?? "N/A");
      if (seizure.make) ctx = drawField(ctx, "Make", seizure.make);
      if (seizure.model) ctx = drawField(ctx, "Model", seizure.model);
      if (seizure.serial_number) ctx = drawField(ctx, "Serial Number", seizure.serial_number);
      ctx = drawField(ctx, "Police Present", seizure.police_present ? "Yes" : "No");
      ctx = drawField(ctx, "Police Officer", seizure.police_name ?? "N/A");
      ctx = drawField(ctx, "Seizure Form Number", seizure.seizure_form_number ?? "N/A");
      ctx = drawField(ctx, "Legal Authority", seizure.legal_authority ?? "RMA 1991 s.327");
      ctx = drawField(ctx, "Seized At", fmtDate(seizure.seized_at));
    } else {
      ctx = drawField(ctx, "Seizure", "No equipment seized");
    }
    // ---- Section 10: Incident Report ----
    ctx = drawSectionTitle(ctx, "10. INCIDENT REPORT");
    ctx = drawField(ctx, "Time on Site", `${fmtDate(assessment.arrived_at)} to ${fmtDate(assessment.departed_at)}`);
    ctx = drawField(ctx, "Duration", fmtDuration(assessment.arrived_at, assessment.departed_at));
    ctx = drawField(ctx, "Action Taken", actionLabels[assessment.action ?? ""] ?? assessment.action ?? "N/A");
    ctx = drawField(ctx, "Follow-up Required", assessment.follow_up_required ? "Yes" : "No");
    // Full incident report text
    if (assessment.incident_report_text) {
      ctx.y -= 6;
      ctx = drawWrappedText(ctx, assessment.incident_report_text);
    }
    // Officer declaration
    ctx.y -= SECTION_GAP;
    ctx = ensureSpace(ctx, LINE_HEIGHT * 5);
    ctx.page.drawLine({
      start: {
        x: MARGIN,
        y: ctx.y
      },
      end: {
        x: PAGE_W - MARGIN,
        y: ctx.y
      },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6)
    });
    ctx.y -= LINE_HEIGHT;
    ctx = drawPdfText(ctx, "OFFICER DECLARATION", fontBold, 10);
    ctx = drawWrappedText(ctx, "I declare that the information contained in this evidence package is true and correct to the best of my knowledge and belief.");
    ctx.y -= LINE_HEIGHT * 2;
    ctx = drawField(ctx, "Officer", assessment.officer_name ?? "N/A");
    ctx = drawField(ctx, "Date", generatedAt);
    // ---- Footer on every page ----
    const pages = pdfDoc.getPages();
    for(let i = 0; i < pages.length; i++){
      const p = pages[i];
      drawPdfRuns(p, `${orgName} | Evidence Package | ${jobNumber} | Page ${i + 1} of ${pages.length}`, fontNormal, 7, MARGIN, 25, rgb(0.5, 0.5, 0.5));
      const footerText = `Generated: ${generatedAt}`;
      const footerWidth = pdfTextWidth(footerText, fontNormal, 7);
      drawPdfRuns(p, footerText, fontNormal, 7, PAGE_W - MARGIN - footerWidth, 25, rgb(0.5, 0.5, 0.5));
    }
    // ---- Save PDF ----
    const pdfBytes = await pdfDoc.save();
    // Verify it is a real PDF (magic bytes: %PDF)
    if (pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50 || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46) {
      return new Response(JSON.stringify({
        error: "Generated file is not a valid PDF"
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
    // ---- Upload to Storage ----
    const storagePath = `org/${assessment.organization_id}/noise-evidence/${assessment_id}.pdf`;
    const { error: uploadErr } = await supabase.storage.from("notice-artifacts").upload(storagePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: true
    });
    if (uploadErr) {
      return new Response(JSON.stringify({
        error: `Storage upload failed: ${uploadErr.message}`
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
    // ---- Update assessment with URL ----
    const { error: updateErr } = await supabase.from("noise_assessments").update({
      evidence_package_url: storagePath
    }).eq("id", assessment_id);
    if (updateErr) {
      console.error("Failed to update evidence_package_url:", updateErr.message);
    }
    return new Response(JSON.stringify({
      ok: true,
      evidence_package_url: storagePath,
      pdf_renderer_version: PDF_RENDERER_VERSION
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-noise-evidence-package error:", msg);
    return new Response(JSON.stringify({
      error: msg
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
