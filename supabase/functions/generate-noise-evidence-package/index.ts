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
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_ROLES = new Set(["grand_master", "master", "admin", "admin_officer"]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
/* ---- Layout constants (A4 in points: 595 x 842) ---- */ const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const LINE_HEIGHT = 14;
const SECTION_GAP = 20;
const PHOTO_MAX_W = 240;
const PHOTO_MAX_H = 180;
function ensureSpace(ctx, needed) {
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
function drawSectionTitle(ctx, title) {
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
  ctx.page.drawText(title, {
    x: MARGIN,
    y: ctx.y,
    size: 12,
    font: ctx.fontBold,
    color: rgb(0, 0, 0)
  });
  ctx.y -= LINE_HEIGHT;
  return ctx;
}
function drawField(ctx, label, value) {
  ctx = ensureSpace(ctx, LINE_HEIGHT * 2);
  ctx.page.drawText(`${label}:`, {
    x: MARGIN,
    y: ctx.y,
    size: 9,
    font: ctx.fontBold,
    color: rgb(0.3, 0.3, 0.3)
  });
  // Wrap long values
  const maxChars = 70;
  const lines = wrapText(value || "N/A", maxChars);
  for (const line of lines){
    ctx = ensureSpace(ctx, LINE_HEIGHT);
    ctx.page.drawText(line, {
      x: MARGIN + 140,
      y: ctx.y,
      size: 9,
      font: ctx.fontNormal,
      color: rgb(0, 0, 0)
    });
    ctx.y -= LINE_HEIGHT;
  }
  return ctx;
}
function wrapText(text, maxChars) {
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
function drawWrappedText(ctx, text, fontSize = 9) {
  const maxChars = Math.floor(CONTENT_W / (fontSize * 0.52));
  const lines = wrapText(text, maxChars);
  for (const line of lines){
    ctx = ensureSpace(ctx, LINE_HEIGHT);
    ctx.page.drawText(line, {
      x: MARGIN,
      y: ctx.y,
      size: fontSize,
      font: ctx.fontNormal,
      color: rgb(0, 0, 0)
    });
    ctx.y -= LINE_HEIGHT;
  }
  return ctx;
}
function fmtDate(d) {
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
function fmtDuration(start, end) {
  if (!start || !end) return "N/A";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "0 minutes";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}
async function embedPhoto(ctx, supabase, photoEntry, label) {
  if (!photoEntry?.storage_path) throw new Error(`${label} has no storage path`);
  try {
    // Get a signed URL for the photo
    if (photoEntry.storage_bucket !== "scans") throw new Error(`${label} is outside the private evidence bucket`);
    const { data: signedData, error: signErr } = await supabase.storage.from(photoEntry.storage_bucket).createSignedUrl(photoEntry.storage_path, 300);
    if (signErr || !signedData?.signedUrl) {
      throw new Error(`${label} is unavailable: ${signErr?.message ?? "no URL"}`);
    }
    const response = await fetch(signedData.signedUrl);
    if (!response.ok) {
      throw new Error(`${label} could not be fetched`);
    }
    const imageBytes = new Uint8Array(await response.arrayBuffer());
    if (imageBytes.length < 10) {
      throw new Error(`${label} is empty`);
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
      throw new Error(`${label} is not a supported JPEG or PNG`);
    }
    // Scale to fit
    const scale = Math.min(PHOTO_MAX_W / embeddedImage.width, PHOTO_MAX_H / embeddedImage.height, 1);
    const drawW = embeddedImage.width * scale;
    const drawH = embeddedImage.height * scale;
    // Label
    ctx = ensureSpace(ctx, drawH + LINE_HEIGHT + 4);
    ctx.page.drawText(label, {
      x: MARGIN,
      y: ctx.y,
      size: 8,
      font: ctx.fontBold,
      color: rgb(0.3, 0.3, 0.3)
    });
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
      ctx.page.drawText(photoEntry.name, {
        x: MARGIN,
        y: ctx.y,
        size: 7,
        font: ctx.fontNormal,
        color: rgb(0.5, 0.5, 0.5)
      });
      ctx.y -= LINE_HEIGHT;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Evidence photo validation failed: ${msg}`);
  }
  return ctx;
}
/* ---- Notice template rendering ---- */ function renderTemplateText(bodyHtml, vars) {
  // Strip HTML tags for plain-text PDF rendering
  let text = bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n").replace(/<\/tr>/gi, "\n").replace(/<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Replace {{variable}} placeholders
  for (const [key, val] of Object.entries(vars)){
    text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
  }
  return text.trim();
}
/* ---- Default RMA citation content (fallback when no notice_templates row) ---- */ function defaultEndNoticeText(assessment) {
  const endNum = assessment.end_number ?? "N/A";
  const occupant = assessment.occupant_name ?? "N/A";
  const address = assessment.noise_source_address ?? assessment.assessment_location ?? "N/A";
  const issuedAt = fmtDate(assessment.arrived_at);
  return [
    "EXCESSIVE NOISE DIRECTION (END)",
    `END Number: ${endNum}`,
    `Issued to: ${occupant}`,
    `Address: ${address}`,
    `Date/Time Issued: ${issuedAt}`,
    "",
    "Legislative Authority: Resource Management Act 1991, Section 326",
    "",
    "You are hereby directed to immediately reduce the noise emanating from",
    "the above address to a reasonable level.",
    "",
    "This direction remains in force for 72 hours from the time of issue.",
    "",
    "Failure to comply with this direction is an offence under Section 327",
    "of the Resource Management Act 1991 and may result in:",
    "  - Seizure of noise-making equipment (s.327)",
    "  - A fine not exceeding $10,000 (s.338(2))",
    "",
    "Equipment seized will be held for a minimum of 28 days.",
    "A return fee may apply."
  ].join("\n");
}
function defaultSeizureNoticeText(assessment, seizure) {
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
    "Legislative Authority: Resource Management Act 1991, Section 327",
    "",
    "The following equipment has been seized under s.327 of the RMA 1991",
    "due to continued non-compliance with an Excessive Noise Direction:",
    "",
    `Items seized: ${items}`,
    `Seizure form number: ${formNum}`,
    `Police officer present: ${policeOfficer}`,
    "",
    "Equipment will be held for a minimum of 28 days.",
    "A return/storage fee may apply upon collection.",
    "Maximum penalty for non-compliance: $10,000 (s.338(2))."
  ].join("\n");
}
/* ---- Volume/Time/Tone labels ---- */ const VOLUME_LABELS = {
  0: "No Noise",
  1: "Barely Audible",
  2: "Clearly Audible",
  3: "Loud",
  4: "Extremely Loud"
};
const TIME_LABELS = {
  1: "7am-9pm",
  2: "9pm-midnight",
  3: "midnight-2am",
  4: "2am-7am"
};
const TONE_LABELS = {
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
const ACTIONS = new Set(["no_noise", "acceptable", "verbal_warning", "end", "seizure"]);
function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hasPhotos(value) {
  return Array.isArray(value) && value.length > 0 && value.every((photo)=>hasText(photo?.storage_path));
}
function validateEvidenceReadiness(assessment) {
  const missing = [];
  if (!hasText(assessment.job_number)) missing.push("job number");
  if (!assessment.officer_id || !hasText(assessment.officer_name)) missing.push("attending officer");
  if (!assessment.received_at) missing.push("complaint received time");
  if (!assessment.arrived_at || !assessment.departed_at) missing.push("arrival and departure times");
  if (!hasText(assessment.complaint_address)) missing.push("complaint address");
  if (!hasText(assessment.noise_source_address)) missing.push("noise source address");
  if (!hasText(assessment.assessment_location)) missing.push("assessment location");
  if (assessment.arrival_gps_lat == null || assessment.arrival_gps_lng == null) missing.push("arrival GPS");
  if (assessment.assessment_gps_lat == null || assessment.assessment_gps_lng == null) missing.push("assessment GPS");
  if (!assessment.hs_checklist_completed) missing.push("completed H&S checklist");
  if (!Array.isArray(assessment.hs_checklist_items) || assessment.hs_checklist_items.length < HS_ITEMS.length || !assessment.hs_checklist_items.slice(0, HS_ITEMS.length).every(Boolean)) {
    missing.push("all H&S checklist confirmations");
  }
  if (!hasPhotos(assessment.photo_assessment_point)) missing.push("assessment-point photograph");
  if (assessment.volume_score == null || assessment.tone_score == null || assessment.matrix_total == null || assessment.volume_score !== 0 && assessment.time_score == null) {
    missing.push("complete TDC matrix");
  }
  if (!ACTIONS.has(assessment.action)) missing.push("supported enforcement action");
  if (!hasText(assessment.incident_report_text)) missing.push("incident report");
  if (assessment.action === "end" || assessment.action === "seizure") {
    if (!hasPhotos(assessment.photo_source_address)) missing.push("source-address photograph");
    if (!hasPhotos(assessment.photo_service_evidence)) missing.push("service photograph");
    if (!hasText(assessment.end_number)) missing.push("END number");
    if (!hasText(assessment.occupant_name)) missing.push("served occupant");
  }
  return missing;
}
function validateSeizureReadiness(seizure) {
  const missing = [];
  if (!seizure) return ["seizure record"];
  if (!hasText(seizure.item_description)) missing.push("seized item description");
  if (!seizure.police_present) missing.push("police presence confirmation");
  if (!hasText(seizure.police_name)) missing.push("police officer name");
  if (!hasText(seizure.seizure_form_number)) missing.push("seizure form number");
  if (!hasPhotos(seizure.photo_urls)) missing.push("seizure photograph");
  return missing;
}
/* ==== Main handler ==== */ serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method !== "POST") return json({
    error: "POST required"
  }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({
      error: "Unauthorized"
    }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({
      error: "Unauthorized"
    }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const { data: profile } = await supabase.from("user_profiles").select("organization_id, role, deactivated_at").eq("id", user.id).maybeSingle();
    if (!profile || profile.deactivated_at || !ADMIN_ROLES.has(String(profile.role))) return json({
      error: "Forbidden"
    }, 403);
    const body = await req.json();
    const assessment_id = String(body.assessment_id ?? "").trim();
    if (!assessment_id) return json({
      error: "assessment_id is required"
    }, 400);
    // ---- Load assessment ----
    const { data: assessment, error: assessErr } = await supabase.from("noise_assessments").select(`id, organization_id, job_number, site_id, status, action,
         received_at, arrived_at, departed_at, created_at,
         officer_id, officer_name,
         volume_score, time_score, tone_score, matrix_total,
         visit_number_tonight, is_problem_address, occupant_cooperative,
         prior_end_within_72hrs, permanent_abatement_active,
         police_requested, police_present,
         end_number, occupant_name,
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
         client_sites!noise_assessments_site_id_fkey(name, address)`).eq("id", assessment_id).eq("organization_id", profile.organization_id).maybeSingle();
    if (assessErr || !assessment) return json({
      error: "Assessment not found"
    }, 404);
    const readinessIssues = validateEvidenceReadiness(assessment);
    if (readinessIssues.length > 0) return json({
      error: "Evidence package is not ready",
      missing: readinessIssues
    }, 409);
    if (assessment.action === "end" || assessment.action === "seizure") {
      const today = new Date().toISOString().slice(0, 10);
      const { data: staff } = await supabase.from("staff_profiles").select("id").eq("user_id", assessment.officer_id).eq("organization_id", assessment.organization_id).maybeSingle();
      const { data: warrant } = staff ? await supabase.from("staff_credentials").select("id").eq("staff_id", staff.id).eq("organization_id", assessment.organization_id).eq("credential_type", "noise_control_warrant").eq("verified", true).or(`expiry_date.is.null,expiry_date.gte.${today}`).limit(1).maybeSingle() : {
        data: null
      };
      if (!warrant) return json({
        error: "Attending officer does not hold an active verified Noise Control warrant"
      }, 409);
    }
    // ---- Load org ----
    const { data: org } = await supabase.from("organizations").select("name, contact_email, contact_phone, logo_url").eq("id", assessment.organization_id).single();
    const orgName = org?.name ?? "Iron Eagle Field Services";
    // ---- Load seizure record (if any) ----
    const { data: seizure } = await supabase.from("noise_seizures").select("id, item_description, police_present, police_name, seizure_form_number, photo_urls, legal_authority, seized_at, make, model, serial_number").eq("noise_assessment_id", assessment_id).maybeSingle();
    if (assessment.action === "seizure") {
      const seizureIssues = validateSeizureReadiness(seizure);
      if (seizureIssues.length > 0) return json({
        error: "Evidence package is not ready",
        missing: seizureIssues
      }, 409);
    }
    // ---- Load notice template (for END or seizure) ----
    const noticeType = assessment.action === "seizure" ? "seizure" : "end";
    const { data: template } = await supabase.from("notice_templates").select("*").eq("organization_id", assessment.organization_id).eq("notice_type", noticeType).eq("is_active", true).order("version", {
      ascending: false
    }).limit(1).maybeSingle();
    // ---- Build PDF ----
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
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
    const siteAddress = assessment.client_sites?.address ?? "N/A";
    const jobNumber = assessment.job_number ?? "N/A";
    const generatedAt = new Date().toLocaleString("en-NZ", {
      timeZone: "Pacific/Auckland",
      dateStyle: "long",
      timeStyle: "short"
    });
    // ---- Title / Header ----
    ctx.page.drawText(orgName, {
      x: MARGIN,
      y: ctx.y,
      size: 16,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    ctx.y -= 18;
    ctx.page.drawText("NOISE CONTROL EVIDENCE PACKAGE", {
      x: MARGIN,
      y: ctx.y,
      size: 14,
      font: fontBold,
      color: rgb(0.13, 0.13, 0.6)
    });
    ctx.y -= 16;
    ctx.page.drawText("Court-Ready Evidence Bundle", {
      x: MARGIN,
      y: ctx.y,
      size: 10,
      font: fontNormal,
      color: rgb(0.4, 0.4, 0.4)
    });
    ctx.y -= LINE_HEIGHT;
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
    const assessmentLabel = total === null || total === 0 ? "No Noise" : total < 5 ? "Acceptable" : "Excessive Noise";
    ctx = drawField(ctx, "Assessment", assessmentLabel);
    const actionLabels = {
      no_noise: "No Noise - no further action",
      acceptable: "Noise acceptable - no further action",
      verbal_warning: "Verbal Warning issued",
      end: "Excessive Noise Direction (END) issued",
      seizure: "Equipment seized - police present"
    };
    ctx = drawField(ctx, "Action Taken", actionLabels[assessment.action] ?? assessment.action ?? "N/A");
    // ---- Section 8: Issued Notices ----
    ctx = drawSectionTitle(ctx, "8. ISSUED NOTICES");
    if (assessment.action === "end" || assessment.action === "seizure") {
      ctx = drawField(ctx, "END Number", assessment.end_number ?? "N/A");
      ctx = drawField(ctx, "Occupant Name", assessment.occupant_name ?? "N/A");
      ctx = drawField(ctx, "Time Issued", fmtDate(assessment.arrived_at));
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
    ctx = drawField(ctx, "Action Taken", actionLabels[assessment.action] ?? assessment.action ?? "N/A");
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
    ctx.page.drawText("OFFICER DECLARATION", {
      x: MARGIN,
      y: ctx.y,
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0)
    });
    ctx.y -= LINE_HEIGHT;
    ctx = drawWrappedText(ctx, "I declare that the information contained in this evidence package is true and correct to the best of my knowledge and belief.");
    ctx.y -= LINE_HEIGHT * 2;
    ctx = drawField(ctx, "Officer", assessment.officer_name ?? "N/A");
    ctx = drawField(ctx, "Date", generatedAt);
    // ---- Footer on every page ----
    const pages = pdfDoc.getPages();
    for(let i = 0; i < pages.length; i++){
      const p = pages[i];
      p.drawText(`${orgName} | Evidence Package | ${jobNumber} | Page ${i + 1} of ${pages.length}`, {
        x: MARGIN,
        y: 25,
        size: 7,
        font: fontNormal,
        color: rgb(0.5, 0.5, 0.5)
      });
      p.drawText(`Generated: ${generatedAt}`, {
        x: PAGE_W - MARGIN - 120,
        y: 25,
        size: 7,
        font: fontNormal,
        color: rgb(0.5, 0.5, 0.5)
      });
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
      await supabase.storage.from("notice-artifacts").remove([
        storagePath
      ]);
      return json({
        error: "Evidence package could not be recorded"
      }, 500);
    }
    return json({
      ok: true,
      evidence_package_url: storagePath
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
