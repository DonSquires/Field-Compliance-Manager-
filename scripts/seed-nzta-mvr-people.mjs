#!/usr/bin/env node
/**
 * One-off seed of canonical person records from R&M NZTA Motochek screenshots
 * (owner ruling 2026-10-26: the R&M screenshot library is source truth until
 * R&M use FCM; consistent screenshots are approved, the rest are held).
 *
 * Stages:
 *   --ocr   Scan the screenshot folders, OCR each image locally (tesseract in
 *           the fcm-inference container, psm 6 + psm 11) and append results to
 *           a local cache. Resumable; PII never leaves this machine.
 *   --plan  Classify every cached screenshot as approve or hold and group
 *           approved screenshots into people (normalised name + address).
 *   --apply Write approved people through the governed identity chain as the
 *           R&M import actor. Rolled back unless --commit.
 *   --reextract  Re-run the field extractor over cached raw OCR text (--output).
 *   --repair-names  Correct seeded people named after the Motochek page heading
 *           through the governed rename and merge RPCs. Rolled back unless
 *           --commit; --plan-only prints the plan; organisation owners and
 *           NZTA-withheld owners stay untouched unless --rename-organisations
 *           and --rename-withheld (owner ruling 2026-10-27: rename both).
 *
 * Reports print counts only. The cache and plan stay outside the repository.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractIdentityFieldsConsensus } = require('../services/fcm-api/src/bob/identityDocument.js');

const CONTAINER = process.env.NZTA_OCR_CONTAINER || 'fcm-inference-laptop';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);
const FILE_NAME = /^([A-Z0-9]{1,8})\s+NZTA\b(?:\s+([A-Z][A-Z0-9&]*(?:\s+[A-Z][A-Z0-9&]*)*?))?\s+(\d{6})\b/i;

const argument = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

export function parseScreenshotName(fileName) {
  const base = path.basename(fileName, path.extname(fileName)).trim();
  const match = FILE_NAME.exec(base);
  if (!match) return null;
  const [, plate, client, yymmdd] = match;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return {
    plate: plate.toUpperCase(),
    client_code: client ? client.toUpperCase() : null,
    file_date: date.toISOString().slice(0, 10),
  };
}

export function normaliseName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function normaliseAddress(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function cleanColour(value) {
  const colour = String(value || '').replace(/country of origin\s*:?.*$/i, '').trim();
  return colour || null;
}

const ORGANISATION_NAME = /\b(limited|ltd|incorporated|inc|trust|council|company|holdings|group|services|rentals?|hire|motors|leasing|partnership|society|school|church|department|ministry|board|club|association|corporation|corp|pty|nz\b)/i;

const OCR_CONFUSABLE = { S: '5', O: '0', D: '0', I: '1', L: '1', B: '8', Z: '2' };
const confusableKey = (plate) => String(plate || '').toUpperCase().replace(/[SODILBZ]/g, (letter) => OCR_CONFUSABLE[letter]);

/**
 * The file name plate is typed by R&M staff and the OCR plate is read from the
 * image; the plate is confirmed when the two independent readings agree,
 * exactly or apart from the usual OCR letter/digit confusions.
 */
export function confirmPlate(fileNamePlate, plateCheck) {
  if (!fileNamePlate || !plateCheck) return null;
  const candidates = Array.isArray(plateCheck.candidates) ? plateCheck.candidates : [];
  if (plateCheck.value === fileNamePlate || candidates.some((candidate) => candidate.value === fileNamePlate)) return 'exact';
  const top = plateCheck.value ?? candidates[0]?.value;
  if (top && top.length === fileNamePlate.length && confusableKey(top) === confusableKey(fileNamePlate)) return 'ocr_confusable';
  return null;
}

/** Classify one OCR result against the owner's consistency rule. */
export function classifyScreenshot(entry) {
  const reasons = [];
  const fields = entry.fields || {};
  if (!entry.parsed) reasons.push('file_name_not_parsed');
  if (entry.name_verification?.status === 'owner_withheld') reasons.push('owner_withheld_by_nzta');
  else if (!fields.display_name) reasons.push('name_not_read');
  if (!fields.query_completed_at) reasons.push('query_date_not_read');
  const plateMatch = entry.parsed ? confirmPlate(entry.parsed.plate, entry.plate_verification) : null;
  if (entry.parsed && !plateMatch) reasons.push('plate_not_confirmed_by_ocr');
  if (fields.display_name && ORGANISATION_NAME.test(fields.display_name)) reasons.push('registered_to_organisation');
  else if (fields.registered_to_company === true) reasons.push('registered_to_organisation');
  if (entry.name_verification?.status === 'variants_disagree') reasons.push('name_ocr_disagreement');
  if (fields.query_completed_at && fields.query_completed_at.slice(0, 10) > new Date().toISOString().slice(0, 10)) reasons.push('query_date_in_future');
  return { decision: reasons.length === 0 ? 'approve' : 'hold', reasons, plate: entry.parsed?.plate ?? null, plate_match: plateMatch };
}

function listScreenshots(roots) {
  const files = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const full = path.join(root, name);
      if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const stat = statSync(full);
      if (!stat.isFile() || stat.size === 0 || stat.size > 25 * 1024 * 1024) continue;
      files.push({ path: full, name, size: stat.size, parsed: parseScreenshotName(name) });
    }
  }
  // Latest first so the newest owner of each plate is processed before older screenshots.
  return files.sort((left, right) => String(right.parsed?.file_date ?? '').localeCompare(String(left.parsed?.file_date ?? ''))
    || left.name.localeCompare(right.name));
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

const execFileAsync = promisify(execFile);

/** Extract the cached fields from the raw OCR passes; kept separate so a fixed extractor can re-read the cache. */
export function extractEntry(variants) {
  const { fields, identifier_verification: verification } = extractIdentityFieldsConsensus(variants, 'nzta_mvr_record');
  if (fields.vehicle_colour) fields.vehicle_colour = cleanColour(fields.vehicle_colour);
  return {
    fields,
    plate_verification: verification?.plate_number ?? null,
    name_verification: verification?.display_name ?? null,
  };
}

// Asynchronous so the --workers slots genuinely overlap.
async function ocrInContainer(file, slot) {
  const remote = `/tmp/nzta-ocr-${process.pid}-${slot}${path.extname(file).toLowerCase()}`;
  await execFileAsync('docker', ['cp', file, `${CONTAINER}:${remote}`]);
  try {
    // One OpenMP thread per tesseract process: parallelism comes from --workers, not oversubscribed threads.
    return await Promise.all([6, 11].map(async (psm) => (await execFileAsync('docker', ['exec', '-e', 'OMP_THREAD_LIMIT=1', CONTAINER, 'tesseract', remote, 'stdout', '--psm', String(psm)], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })).stdout));
  } finally {
    await execFileAsync('docker', ['exec', '-u', 'root', CONTAINER, 'rm', '-f', remote]).catch(() => {});
  }
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  // The OCR run may be appending while another stage reads, so skip a partial last line.
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function completedOcrPaths(entries) {
  return new Set(entries.filter((entry) => !entry.error && /^[0-9a-f]{64}$/.test(entry.sha256 ?? '')).map((entry) => entry.path));
}

export function screenshotContentMatches(bytes, screenshot) {
  return bytes.length === screenshot.size && createHash('sha256').update(bytes).digest('hex') === screenshot.sha;
}

async function runOcr({ roots, cache, limit, workers }) {
  const done = completedOcrPaths(readJsonLines(cache));
  const pending = listScreenshots(roots).filter((file) => !done.has(file.path)).slice(0, limit);
  let next = 0;
  let completed = 0;
  let failed = 0;
  const started = Date.now();
  const worker = async (slot) => {
    while (next < pending.length) {
      const file = pending[next++];
      try {
        const variants = await ocrInContainer(file.path, slot);
        appendFileSync(cache, `${JSON.stringify({
          path: file.path, name: file.name, size: file.size, parsed: file.parsed, sha256: await sha256(file.path),
          ...extractEntry(variants), ocr_variants: variants, ocr_at: new Date().toISOString(),
        })}\n`);
        completed += 1;
      } catch (error) {
        failed += 1;
        appendFileSync(cache, `${JSON.stringify({ path: file.path, name: file.name, error: String(error.message).slice(0, 200) })}\n`);
      }
      if ((completed + failed) % 25 === 0) {
        const rate = (Date.now() - started) / 1000 / (completed + failed);
        console.log(`ocr ${completed + failed}/${pending.length} failed=${failed} ${rate.toFixed(1)}s/image`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, slot) => worker(slot)));
  return { pending: pending.length, completed, failed, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Group approved screenshots into people and pick each plate's latest owner. */
export function buildPlan(entries) {
  const latest = new Map();
  for (const entry of entries) {
    if (entry.error || !entry.sha256) continue;
    const key = entry.sha256;
    if (!latest.has(key)) latest.set(key, entry);
  }
  const screenshots = [...latest.values()].map((entry) => ({ ...entry, ...classifyScreenshot(entry) }));
  const approved = screenshots.filter((entry) => entry.decision === 'approve');
  const people = new Map();
  for (const entry of approved) {
    const name = normaliseName(entry.fields.display_name);
    const address = normaliseAddress(entry.fields.physical_address);
    const key = address ? `${name}|${address}` : `${name}|plate:${entry.plate}`;
    const person = people.get(key) ?? { key, display_name: entry.fields.display_name, screenshots: [] };
    person.screenshots.push(entry);
    people.set(key, person);
  }
  const ownerByPlate = new Map();
  for (const entry of approved) {
    const current = ownerByPlate.get(entry.plate);
    if (!current || entry.fields.query_completed_at > current.fields.query_completed_at) ownerByPlate.set(entry.plate, entry);
  }
  for (const person of people.values()) {
    person.screenshots.sort((left, right) => right.fields.query_completed_at.localeCompare(left.fields.query_completed_at));
    for (const shot of person.screenshots) shot.current_owner = ownerByPlate.get(shot.plate)?.sha256 === shot.sha256;
  }
  const holdReasons = {};
  for (const entry of screenshots.filter((item) => item.decision === 'hold')) {
    for (const reason of entry.reasons) holdReasons[reason] = (holdReasons[reason] ?? 0) + 1;
  }
  return {
    summary: {
      screenshots: screenshots.length,
      ocr_errors: entries.filter((entry) => entry.error).length,
      approved: approved.length,
      held: screenshots.length - approved.length,
      hold_reasons: holdReasons,
      people: people.size,
      plates_with_current_owner: ownerByPlate.size,
    },
    people: [...people.values()],
    held: screenshots.filter((entry) => entry.decision === 'hold').map(({ path: file, name, reasons }) => ({ path: file, name, reasons })),
  };
}

const RM_ORGANIZATION_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const IMPORT_ACTOR_ID = 'f1c00000-0000-4000-8000-000000000001';
const SOURCE_RULING = 'Owner source-truth ruling 2026-10-26: the R&M NZTA Motochek screenshot library is verified source truth until R&M use FCM. '
  + 'OCR of this screenshot agrees with the staff-typed file-name plate. Seeded by scripts/seed-nzta-mvr-people.mjs.';
const FILE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const firstToken = (value) => String(value ?? '').trim().split(/\s+/)[0] ?? '';
export const seedPersonKey = (key) => createHash('sha256').update(`rm-nzta-seed|${key}`).digest('hex').slice(0, 32);
export const storagePathFor = (personRecordId, sha, extension) =>
  `org/${RM_ORGANIZATION_ID}/identity/${IMPORT_ACTOR_ID}/submission-${personRecordId}/nzta-${sha.slice(0, 16)}${extension}`;

/**
 * Only facts in a clean, checkable form are promoted; anything the OCR blurred into a
 * neighbouring label stays in the advisory proposal for a human to read from the image.
 */
export function approvedVehicleFields(entry) {
  const fields = entry.fields || {};
  const vin = firstToken(fields.vin).toUpperCase();
  const chassis = firstToken(fields.chassis_number).toUpperCase();
  const fuel = /^(petrol hybrid|diesel hybrid|petrol|diesel|electric|lpg|cng)\b/i.exec(String(fields.fuel_type ?? '').trim())?.[1];
  const year = /^\d{4}$/.test(String(fields.vehicle_year ?? '')) ? String(fields.vehicle_year) : null;
  const clean = (value) => (value == null ? null : String(value).trim() || null);
  return Object.fromEntries(Object.entries({
    display_name: clean(fields.display_name),
    plate_number: entry.plate,
    person_vehicle_match_confirmed: 'true',
    vehicle_make: clean(fields.vehicle_make),
    vehicle_model: clean(fields.vehicle_model),
    vehicle_year: year,
    vehicle_colour: clean(fields.vehicle_colour),
    vin: /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null,
    chassis_number: /\d/.test(chassis) && /^[A-Z0-9]+(-[A-Z0-9]+)?$/.test(chassis) ? chassis : null,
    rego_expiry: ISO_DATE.test(fields.rego_expiry ?? '') ? fields.rego_expiry : null,
    wof_expiry: ISO_DATE.test(fields.wof_expiry ?? '') ? fields.wof_expiry : null,
    fuel_type: fuel ? fuel.replace(/\b\w/g, (letter) => letter.toUpperCase()) : null,
  }).filter(([, value]) => value != null));
}

function dollarQuote(json, tag) {
  if (json.includes(`$${tag}$`)) throw new Error('Seed data must not contain its SQL delimiter');
  return `$${tag}$${json}$${tag}$::jsonb`;
}

const CLAIMS = `set local request.jwt.claim.sub = '${IMPORT_ACTOR_ID}';
set local request.jwt.claims = '{"sub":"${IMPORT_ACTOR_ID}","role":"authenticated"}';`;

/** Resolve or create one R&M person per planned identity; results land in a temp table. */
export function peopleSql(people) {
  return `CREATE TEMP TABLE IF NOT EXISTS nzta_seed_people (key_hash text PRIMARY KEY, person_record_id uuid, created boolean, error text);
DO $seed$
DECLARE r jsonb; v_person uuid; v_created boolean; v_result jsonb;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(people), 'seed_people')}) LOOP
    BEGIN
      v_person := NULL; v_created := false;
      -- The person already holding one of these screenshots wins: keys and names can change after a repair.
      SELECT d.person_record_id INTO v_person
      FROM public.evidence_items e
      JOIN public.person_identity_documents d ON d.evidence_item_id = e.id AND d.organization_id = e.organization_id
      JOIN public.person_records p ON p.id = d.person_record_id
      WHERE e.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND e.module_key = 'identity_registry'
        AND d.document_kind = 'nzta_mvr_record'
        AND e.sha256_hash IN (SELECT jsonb_array_elements_text(coalesce(r->'shas', '[]'::jsonb)))
        AND NOT (p.metadata ? 'merged_into_person_record_id') AND NOT (p.metadata ? 'resolved_into_person_record_id')
      ORDER BY p.created_at, p.id
      LIMIT 1;
      IF v_person IS NULL THEN
      SELECT d.person_record_id INTO v_person
      FROM public.person_identity_documents d
      JOIN public.person_records p ON p.id = d.person_record_id
      WHERE d.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND d.document_kind = 'nzta_mvr_record'
        AND NOT (p.metadata ? 'merged_into_person_record_id') AND NOT (p.metadata ? 'resolved_into_person_record_id')
        AND (d.extracted_fields->'proposed'->>'seed_person_key' = r->>'key_hash'
          OR (r->>'address_compact' <> ''
            AND regexp_replace(lower(coalesce(d.extracted_fields->'proposed'->>'physical_address', d.extracted_fields->'proposed'->>'address', '')), '[^a-z0-9]+', '', 'g') = r->>'address_compact'
            AND regexp_replace(lower(p.display_name), '[^a-z0-9]+', '', 'g') = r->>'name_compact'))
      ORDER BY d.created_at
      LIMIT 1;
      END IF;
      IF v_person IS NULL THEN
        SELECT person_record_id INTO v_person FROM nzta_seed_people WHERE key_hash = r->>'key_hash' AND person_record_id IS NOT NULL;
      END IF;
      IF v_person IS NULL THEN
        -- A person this seed created earlier whose screenshots did not land yet (interrupted run).
        SELECT p.id INTO v_person
        FROM public.audit_log a
        JOIN public.person_records p ON p.id = a.target_id AND p.organization_id = a.organization_id
        WHERE a.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND a.actor_user_id = '${IMPORT_ACTOR_ID}'::uuid
          AND a.action = 'identity_person_create' AND a.target_table = 'person_records'
          AND (a.metadata->>'reason' = '${SOURCE_RULING} Seed key ' || (r->>'key_hash') || '.'
            OR (a.metadata->>'reason' = '${SOURCE_RULING}'
              AND regexp_replace(lower(p.display_name), '[^a-z0-9]+', '', 'g') = r->>'name_compact'
              AND NOT EXISTS (SELECT 1 FROM public.person_identity_documents d WHERE d.person_record_id = p.id)))
        ORDER BY a.created_at
        LIMIT 1;
      END IF;
      IF v_person IS NULL THEN
        v_result := public.manage_identity_person_record('${RM_ORGANIZATION_ID}'::uuid, NULL, 'create',
          jsonb_build_object('display_name', r->>'display_name', 'confirm_new_person', true, 'nzta_mvr_sourced', true),
          '${SOURCE_RULING} Seed key ' || (r->>'key_hash') || '.');
        v_person := (v_result->>'person_record_id')::uuid;
        v_created := true;
      END IF;
      INSERT INTO nzta_seed_people VALUES (r->>'key_hash', v_person, v_created, NULL)
      ON CONFLICT (key_hash) DO UPDATE SET person_record_id = excluded.person_record_id, created = nzta_seed_people.created OR excluded.created, error = NULL;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO nzta_seed_people VALUES (r->>'key_hash', NULL, false, left(SQLERRM, 200))
      ON CONFLICT (key_hash) DO UPDATE SET error = excluded.error;
    END;
  END LOOP;
END $seed$;`;
}

/**
 * Register source evidence, review owner identity independently from disputed
 * vehicle facts, then rebuild registered-owner links from source check time.
 * Screenshots run oldest first so the latest check remains canonical.
 */
export function screenshotsSql(screenshots, { dryRun }) {
  return `CREATE TEMP TABLE IF NOT EXISTS nzta_seed_people (key_hash text PRIMARY KEY, person_record_id uuid, created boolean, error text);
CREATE TEMP TABLE IF NOT EXISTS nzta_seed_results (sha text PRIMARY KEY, outcome text, person_record_id uuid, identity_document_id uuid, owner_linked boolean, error text);
DO $seed$
DECLARE s jsonb; v_person uuid; v_path text; v_doc uuid; v_query timestamptz; v_newer timestamptz; v_vehicle uuid;
  v_result jsonb; v_outcome text; v_error text; v_linked boolean;
  v_existing_person uuid; v_document_state text;
BEGIN
  FOR s IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(screenshots), 'seed_shots')}) LOOP
    v_doc := NULL; v_outcome := NULL; v_error := NULL; v_linked := false;
    v_person := coalesce((s->>'person_record_id')::uuid, (SELECT person_record_id FROM nzta_seed_people WHERE key_hash = s->>'key_hash'));
    SELECT document.id, document.person_record_id, document.review_state
      INTO v_doc, v_existing_person, v_document_state
    FROM public.evidence_items evidence
    JOIN public.person_identity_documents document
      ON document.evidence_item_id = evidence.id
     AND document.organization_id = evidence.organization_id
    WHERE evidence.organization_id = '${RM_ORGANIZATION_ID}'::uuid
      AND evidence.module_key = 'identity_registry'
      AND evidence.sha256_hash = s->>'sha'
      AND document.document_kind = 'nzta_mvr_record'
    ORDER BY document.created_at DESC
    LIMIT 1;
    IF v_doc IS NOT NULL THEN
      IF v_person IS NULL THEN v_person := v_existing_person; END IF;
      IF v_person IS DISTINCT FROM v_existing_person THEN
        v_outcome := 'held_existing_person_mismatch';
        v_error := 'Existing evidence is linked to a different tenant person record.';
      ELSE
        SELECT check_row.canonical_vehicle_id
          INTO v_vehicle
        FROM public.vehicle_identity_checks check_row
        WHERE check_row.identity_document_id = v_doc;
        IF v_vehicle IS NOT NULL THEN
          PERFORM public.sync_nzta_registered_owner_history('${RM_ORGANIZATION_ID}'::uuid, v_vehicle);
          v_outcome := 'already_present';
          v_linked := true;
        ELSIF v_document_state = 'manual_review_required' THEN
          v_query := (s->>'query_local')::timestamp AT TIME ZONE 'Pacific/Auckland';
          v_result := public.review_nzta_mvr_owner_evidence(
            v_doc,
            (s->'approved') || jsonb_build_object('query_completed_at', v_query),
            '${SOURCE_RULING} Owner identity reviewed; vehicle facts remain pending.'
          );
          v_vehicle := (v_result->>'canonical_vehicle_id')::uuid;
          v_outcome := 'owner_approved_vehicle_facts_pending';
          v_linked := true;
        ELSE
          v_outcome := 'held_document_without_owner_check';
          v_error := 'Existing document is not pending and has no source-time owner check.';
        END IF;
      END IF;
      INSERT INTO nzta_seed_results VALUES (s->>'sha', v_outcome, v_person, v_doc, v_linked, v_error)
      ON CONFLICT (sha) DO UPDATE SET outcome = excluded.outcome, person_record_id = excluded.person_record_id,
        identity_document_id = excluded.identity_document_id, owner_linked = excluded.owner_linked, error = excluded.error;
      CONTINUE;
    END IF;
    IF v_person IS NULL THEN
      INSERT INTO nzta_seed_results VALUES (s->>'sha', 'no_person', NULL, NULL, false, NULL) ON CONFLICT (sha) DO NOTHING;
      CONTINUE;
    END IF;
    v_path := 'org/${RM_ORGANIZATION_ID}/identity/${IMPORT_ACTOR_ID}/submission-' || v_person::text || '/nzta-' || left(s->>'sha', 16) || (s->>'extension');
    v_query := (s->>'query_local')::timestamp AT TIME ZONE 'Pacific/Auckland';
    BEGIN
      ${dryRun ? `IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'identity-evidence' AND name = v_path) THEN
        INSERT INTO storage.objects (bucket_id, name, metadata)
        VALUES ('identity-evidence', v_path, jsonb_build_object('size', (s->>'size')::bigint, 'dry_run', true));
      END IF;` : ''}
      PERFORM public.register_person_identity_submission(v_person, 'nzta_mvr_record', (s->>'attachment_id')::uuid,
        s->>'file_name', s->>'file_type', (s->>'size')::bigint, v_path);
      v_result := public.register_deterministic_identity_document_proposal('${IMPORT_ACTOR_ID}'::uuid, '${RM_ORGANIZATION_ID}'::uuid,
        v_person, (s->>'attachment_id')::uuid, 'nzta_mvr_record', s->>'sha', s->'proposed');
      v_doc := (v_result->>'identity_document_id')::uuid;
      SELECT max(c.checked_at) INTO v_newer FROM public.vehicle_identity_checks c
      JOIN public.canonical_vehicles cv ON cv.id = c.canonical_vehicle_id
      WHERE c.organization_id = '${RM_ORGANIZATION_ID}'::uuid
        AND cv.plate_number = public.normalize_plate_number(s->'approved'->>'plate_number');
        IF v_newer IS NOT NULL AND v_newer > v_query THEN
          v_result := public.review_nzta_mvr_owner_evidence(
            v_doc,
            (s->'approved') || jsonb_build_object('query_completed_at', v_query),
            '${SOURCE_RULING} Historical owner identity reviewed; newer vehicle facts are preserved.'
          );
          v_outcome := 'owner_approved_vehicle_facts_pending';
        ELSE
          BEGIN
          v_result := public.review_nzta_mvr_identity_evidence(v_doc, 'approve',
            (s->'approved') || jsonb_build_object('query_completed_at', v_query), '${SOURCE_RULING}');
          v_outcome := 'approved';
          EXCEPTION WHEN OTHERS THEN
            IF SQLERRM IN (
              'Shared canonical vehicle facts require grand master review; organization notes can still be updated',
              'Conflicting canonical vehicle identifiers require grand master review'
            ) THEN
              v_result := public.review_nzta_mvr_owner_evidence(
                v_doc,
                (s->'approved') || jsonb_build_object('query_completed_at', v_query),
                '${SOURCE_RULING} Registered owner confirmed; shared vehicle facts remain pending.'
              );
              v_outcome := 'owner_approved_vehicle_facts_pending';
            ELSE
              RAISE;
            END IF;
          END;
        END IF;
        v_vehicle := (v_result->>'canonical_vehicle_id')::uuid;
        v_linked := true;
    EXCEPTION WHEN OTHERS THEN
      v_outcome := CASE
        WHEN SQLERRM LIKE 'Conflicting owners share an NZTA check timestamp%' THEN 'held_owner_history_conflict'
        WHEN SQLERRM LIKE 'A manually recorded registered owner needs review%' THEN 'held_owner_history_conflict'
        ELSE 'held_for_review'
      END;
      v_error := left(SQLERRM, 200);
    END;
    INSERT INTO nzta_seed_results VALUES (s->>'sha', v_outcome, v_person, v_doc, v_linked, v_error)
    ON CONFLICT (sha) DO UPDATE SET outcome = excluded.outcome, identity_document_id = excluded.identity_document_id,
      owner_linked = excluded.owner_linked, error = excluded.error;
  END LOOP;
END $seed$;`;
}

/** Turn a plan into the people and screenshot payloads the SQL stages consume. */
export function applyPayload(plan, { limitPeople } = {}) {
  const people = plan.people.slice(0, limitPeople ?? plan.people.length).map((person) => {
    const shot = person.screenshots[0];
    return {
      key_hash: seedPersonKey(person.key),
      display_name: String(person.display_name).trim(),
      name_compact: String(person.display_name).toLowerCase().replace(/[^a-z0-9]+/g, ''),
      address_compact: normaliseAddress(shot.fields.physical_address),
      shas: person.screenshots.map((entry) => entry.sha256),
    };
  });
  const keys = new Map(plan.people.slice(0, people.length).map((person, index) => [person, people[index].key_hash]));
  const screenshots = [];
  for (const [person, keyHash] of keys) {
    for (const shot of person.screenshots) {
      const extension = path.extname(shot.name).toLowerCase();
      if (!FILE_TYPES[extension]) continue;
      screenshots.push({
        sha: shot.sha256, key_hash: keyHash, path: shot.path, extension, file_type: FILE_TYPES[extension],
        file_name: `NZTA ${shot.plate} ${shot.fields.query_completed_at.slice(0, 10)}${extension}`,
        size: shot.size, query_local: shot.fields.query_completed_at, current_owner: Boolean(shot.current_owner),
        attachment_id: randomUUID(),
        proposed: { ...shot.fields, seed_person_key: keyHash, source: 'rm_nzta_screenshot_library', file_name_plate: shot.plate,
          plate_match: shot.plate_match, client_code: shot.parsed?.client_code ?? null },
        approved: approvedVehicleFields(shot),
      });
    }
  }
  screenshots.sort((left, right) => left.query_local.localeCompare(right.query_local) || left.sha.localeCompare(right.sha));
  return { people, screenshots };
}

const strip = ({ path: _path, ...rest }) => rest;
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

async function seedCliQuery() {
  const { cliQuery: rawQuery } = await import('../services/document-source-worker/reconcile-plan.mjs');
  return (sql) => {
    try { return rawQuery(sql); } catch (error) {
      // Postgres echoes the failing line, which can quote seed data; keep the full text in a local file only.
      const text = String(error.stderr || '') + String(error.stdout || '') + String(error.message);
      if (process.env.NZTA_SEED_ERROR_LOG) writeFileSync(process.env.NZTA_SEED_ERROR_LOG, text);
      const message = text.split('\n').find((line) => /ERROR|error:/i.test(line)) ?? 'query failed';
      throw new Error(message.slice(0, 300));
    }
  };
}

async function runApply({ plan, commit, limitPeople, report }) {
  const cliQuery = await seedCliQuery();
  const { people, screenshots } = applyPayload(plan, { limitPeople });
  let peopleRows;
  let resultRows;
  if (!commit) {
    peopleRows = [];
    resultRows = [];
    const batches = chunk(people, 25);
    for (const batch of batches) {
      const batchKeys = new Set(batch.map((person) => person.key_hash));
      const batchScreenshots = screenshots.filter((shot) => {
        if (!batchKeys.has(shot.key_hash)) return false;
        if (screenshotContentMatches(readFileSync(shot.path), shot)) return true;
        resultRows.push({ sha: shot.sha, outcome: 'held_source_changed', error: 'Screenshot differs from the OCR cache; invalidate its cache entry and rerun OCR.' });
        return false;
      });
      const rows = cliQuery(`BEGIN;\n${CLAIMS}\n${peopleSql(batch)}\n${screenshotsSql(batchScreenshots.map(strip), { dryRun: true })}
SELECT jsonb_build_object('people', (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]') FROM nzta_seed_people p),
  'results', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') FROM nzta_seed_results r)) AS out;\nROLLBACK;`);
      peopleRows.push(...rows[0].out.people);
      resultRows.push(...rows[0].out.results);
      console.log(`dry-run checked ${peopleRows.length}/${people.length} people`);
    }
  } else {
    if ((!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) && existsSync('.env')) process.loadEnvFile('.env');
    const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceRole } = process.env;
    if (!url || !serviceRole) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to upload the private screenshots');
    const { createClient } = await import('@supabase/supabase-js');
    const storage = createClient(url, serviceRole, { auth: { persistSession: false } }).storage.from('identity-evidence');
    peopleRows = [];
    for (const batch of chunk(people, 25)) {
      const rows = cliQuery(`BEGIN;\n${CLAIMS}\n${peopleSql(batch)}\nSELECT coalesce(jsonb_agg(to_jsonb(p)), '[]') AS out FROM nzta_seed_people p;\nCOMMIT;`);
      peopleRows.push(...rows[0].out);
    }
    const personByKey = new Map(peopleRows.filter((row) => row.person_record_id).map((row) => [row.key_hash, row.person_record_id]));
    const present = new Set(cliQuery(`BEGIN READ ONLY;
SELECT sha256_hash AS sha FROM public.evidence_items WHERE organization_id = '${RM_ORGANIZATION_ID}'::uuid AND module_key = 'identity_registry'
  AND sha256_hash IN (SELECT jsonb_array_elements_text(${dollarQuote(JSON.stringify(screenshots.map((shot) => shot.sha)), 'seed_shas')}));
ROLLBACK;`).map((row) => row.sha));
    resultRows = [];
    for (const batch of chunk(screenshots, 40)) {
      const ready = [];
      for (const shot of batch) {
        const personRecordId = personByKey.get(shot.key_hash);
        if (!personRecordId || present.has(shot.sha)) { ready.push({ ...strip(shot), person_record_id: personRecordId ?? null }); continue; }
        const bytes = readFileSync(shot.path);
        if (!screenshotContentMatches(bytes, shot)) {
          resultRows.push({ sha: shot.sha, outcome: 'held_source_changed', error: 'Screenshot differs from the OCR cache; invalidate its cache entry and rerun OCR.' });
          continue;
        }
        const { error } = await storage.upload(storagePathFor(personRecordId, shot.sha, shot.extension), bytes,
          { contentType: shot.file_type, upsert: false });
        if (error && !/exists/i.test(error.message)) { resultRows.push({ sha: shot.sha, outcome: 'upload_failed', error: error.message.slice(0, 200) }); continue; }
        ready.push({ ...strip(shot), person_record_id: personRecordId });
      }
      if (ready.length === 0) continue;
      const rows = cliQuery(`BEGIN;\n${CLAIMS}\n${screenshotsSql(ready, { dryRun: false })}
SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') AS out FROM nzta_seed_results r;\nCOMMIT;`);
      resultRows.push(...rows[0].out);
      console.log(`applied ${resultRows.length}/${screenshots.length}`);
    }
  }
  const tally = (rows, field) => rows.reduce((counts, row) => ({ ...counts, [row[field]]: (counts[row[field]] ?? 0) + 1 }), {});
  const errors = resultRows.filter((row) => row.error).reduce((counts, row) => ({ ...counts, [row.error]: (counts[row.error] ?? 0) + 1 }), {});
  const summary = {
    mode: commit ? 'committed' : 'dry_run_rolled_back',
    people: { planned: people.length, created: peopleRows.filter((row) => row.created).length,
      matched_existing: peopleRows.filter((row) => row.person_record_id && !row.created).length,
      failed: peopleRows.filter((row) => row.error).length },
    screenshots: { planned: screenshots.length, outcomes: tally(resultRows, 'outcome'),
      owner_links: resultRows.filter((row) => row.owner_linked).length },
    errors,
  };
  if (report) {
    if (path.resolve(report).startsWith(path.resolve('.'))) throw new Error('The apply report must live outside the repository');
    writeFileSync(report, JSON.stringify({ summary, people: peopleRows, results: resultRows }, null, 2));
  }
  return summary;
}

/** Matches the Motochek page heading that the first seed stored as every owner's name. */
export const HEADING_NAME = /^\s*details\s*\(\s*\d+\s+registered\s+persons?\s*\)\s*$/i;
const HEADING_NAME_SQL = '^\\s*details\\s*\\(\\s*\\d+\\s+registered\\s+persons?\\s*\\)\\s*$';
const ownerKey = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const compactName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const REPAIR_RENAME_REASON = 'NZTA owner-name correction: the first R&M NZTA seed stored the Motochek heading '
  + '"Current registered person details (N registered persons)" as the owner name. The corrected name is the '
  + '"Current registered person" field read by two OCR passes of the same private source screenshot(s). '
  + 'Repaired by scripts/seed-nzta-mvr-people.mjs --repair-names.';
const REPAIR_MERGE_REASON = 'Same NZTA registered owner (same name and address on the source screenshots) was split across '
  + 'seed records by the heading-as-name defect. Merged by scripts/seed-nzta-mvr-people.mjs --repair-names.';
export const ORGANISATION_OWNER_CATEGORY = 'Registered vehicle owner (organisation)';
export const WITHHELD_OWNER_NAME = 'Owner withheld by NZTA';
export const WITHHELD_OWNER_CATEGORY = 'Registered vehicle owner (withheld by NZTA)';

function ownerReading(entry) {
  const readings = (entry.name_verification?.readings ?? []).map((reading) => reading.value).filter(Boolean);
  if (readings.length === 0 && entry.fields?.display_name) readings.push(entry.fields.display_name);
  return {
    keys: new Set(readings.map(ownerKey).filter(Boolean)),
    organisation: entry.fields?.registered_to_company === true || readings.some((value) => ORGANISATION_NAME.test(value)),
    withheld: entry.name_verification?.status === 'owner_withheld',
  };
}

/**
 * Plan the correction of seeded people named after the page heading. Each live person is renamed only
 * when every readable screenshot it holds names the same owner; people whose screenshots name different
 * owners are reported, never split. Renamed people sharing a name and address (or plate) are merged.
 */
export function planNameRepair(entries, liveRows, { renameOrganisations = false, renameWithheld = false } = {}) {
  const bySha = new Map();
  for (const entry of entries) if (!entry.error && entry.sha256 && !bySha.has(entry.sha256)) bySha.set(entry.sha256, entry);
  const persons = new Map();
  for (const row of liveRows) {
    const person = persons.get(row.person_record_id) ?? { ...row, shas: [] };
    person.shas.push(row.sha);
    persons.set(row.person_record_id, person);
  }
  const statuses = {};
  const candidates = [];
  const withheldGroups = [];
  let shasWithoutCache = 0;
  for (const person of persons.values()) {
    const shots = person.shas.map((sha) => bySha.get(sha)).filter(Boolean);
    shasWithoutCache += person.shas.length - shots.length;
    const named = shots.map((entry) => ({ entry, reading: ownerReading(entry) })).filter((item) => item.reading.keys.size > 0);
    let status;
    let common = [];
    if (named.length === 0) {
      const allWithheld = shots.length === person.shas.length && shots.every((entry) => ownerReading(entry).withheld);
      status = allWithheld ? 'owner_withheld_only' : 'unreadable';
      if (allWithheld && renameWithheld && person.heading_name) {
        withheldGroups.push([{ kind: 'rename', person_record_id: person.person_record_id, display_name: WITHHELD_OWNER_NAME,
          category: WITHHELD_OWNER_CATEGORY }]);
      }
    }
    else {
      common = [...named[0].reading.keys].filter((key) => named.every((item) => item.reading.keys.has(key)));
      if (common.length === 0) status = 'mixed_owners';
      else if (named.some((item) => item.reading.organisation)) status = renameOrganisations ? 'organisation' : 'organisation_held';
      else status = 'person';
    }
    if (status === 'person' || status === 'organisation') {
      // Prefer the newest screenshot whose consensus name is one of the agreed spellings.
      const ordered = [...named].sort((left, right) => String(right.entry.fields?.query_completed_at ?? '')
        .localeCompare(String(left.entry.fields?.query_completed_at ?? '')));
      const chosen = ordered.find((item) => common.includes(ownerKey(item.entry.fields?.display_name)))?.entry.fields.display_name
        ?? ordered[0].entry.name_verification.readings.find((reading) => common.includes(ownerKey(reading.value))).value;
      const eligible = person.heading_name || person.name_compact === compactName(chosen);
      if (!eligible) status = 'kept_existing_name';
      else {
        const keys = named.map(({ entry }) => {
          const address = normaliseAddress(entry.fields?.physical_address);
          return address ? `${normaliseName(chosen)}|${address}` : `${normaliseName(chosen)}|plate:${entry.parsed?.plate ?? ''}`;
        });
        candidates.push({ person, display_name: String(chosen).trim(), organisation: status === 'organisation', keys });
      }
    }
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  // Union people that share a name+address (or name+plate) key.
  const parent = new Map(candidates.map((candidate) => [candidate, candidate]));
  const find = (node) => (parent.get(node) === node ? node : find(parent.get(node)));
  const byKey = new Map();
  for (const candidate of candidates) {
    for (const key of candidate.keys) {
      if (byKey.has(key)) parent.set(find(candidate), find(byKey.get(key)));
      else byKey.set(key, candidate);
    }
  }
  const components = new Map();
  for (const candidate of candidates) {
    const root = find(candidate);
    components.set(root, [...(components.get(root) ?? []), candidate]);
  }
  const groups = [];
  for (const members of components.values()) {
    members.sort((left, right) => Number(right.person.review_state === 'verified') - Number(left.person.review_state === 'verified')
      || String(left.person.person_created_at).localeCompare(String(right.person.person_created_at))
      || left.person.person_record_id.localeCompare(right.person.person_record_id));
    const [target] = members;
    const actions = members.filter((member) => member.person.name_compact !== compactName(target.display_name))
      .map((member) => ({ kind: 'rename', person_record_id: member.person.person_record_id, display_name: target.display_name,
        ...(target.organisation ? { category: ORGANISATION_OWNER_CATEGORY } : {}) }));
    for (const member of members.slice(1)) {
      actions.push({ kind: 'merge', source: member.person.person_record_id, target: target.person.person_record_id,
        display_name: target.display_name, name_compact: compactName(target.display_name) });
    }
    if (actions.length > 0) groups.push(actions);
  }
  groups.push(...withheldGroups);
  const actions = groups.flat();
  return {
    summary: {
      live_people: persons.size,
      live_screenshots: liveRows.length,
      screenshots_without_cache: shasWithoutCache,
      people_by_status: statuses,
      renames: actions.filter((action) => action.kind === 'rename').length,
      merges: actions.filter((action) => action.kind === 'merge').length,
    },
    groups,
  };
}

export function liveSeedRowsSql() {
  return `BEGIN READ ONLY;
SELECT coalesce(jsonb_agg(jsonb_build_object('sha', e.sha256_hash, 'person_record_id', p.id, 'person_created_at', p.created_at,
  'review_state', p.review_state, 'heading_name', p.display_name ~* '${HEADING_NAME_SQL}',
  'name_compact', regexp_replace(lower(p.display_name), '[^a-z0-9]+', '', 'g'))), '[]'::jsonb) AS out
FROM public.evidence_items e
JOIN public.person_identity_documents d ON d.evidence_item_id = e.id AND d.organization_id = e.organization_id
JOIN public.person_records p ON p.id = d.person_record_id AND p.organization_id = e.organization_id
WHERE e.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND e.module_key = 'identity_registry'
  AND d.document_kind = 'nzta_mvr_record'
  AND NOT (p.metadata ? 'merged_into_person_record_id') AND NOT (p.metadata ? 'resolved_into_person_record_id');
ROLLBACK;`;
}

/** Governed rename and merge calls; each action is guarded so a re-run is a no-op. */
export function repairSql(actions) {
  return `CREATE TEMP TABLE IF NOT EXISTS nzta_repair_results (seq integer PRIMARY KEY, kind text, person_record_id uuid, outcome text, error text);
DO $repair$
DECLARE a jsonb; v_seq integer := coalesce((SELECT max(seq) FROM nzta_repair_results), 0); v_name text; v_target_name text;
  v_merged_into text; v_outcome text; v_error text;
BEGIN
  FOR a IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(actions), 'repair_actions')}) LOOP
    v_seq := v_seq + 1; v_outcome := NULL; v_error := NULL;
    BEGIN
      IF a->>'kind' = 'rename' THEN
        SELECT display_name, metadata->>'merged_into_person_record_id' INTO v_name, v_merged_into FROM public.person_records
        WHERE id = (a->>'person_record_id')::uuid AND organization_id = '${RM_ORGANIZATION_ID}'::uuid;
        IF v_name IS NULL OR v_merged_into IS NOT NULL THEN v_outcome := 'skipped_missing_or_merged';
        ELSIF v_name = a->>'display_name' THEN v_outcome := 'already_named';
        ELSIF v_name !~* '${HEADING_NAME_SQL}' THEN v_outcome := 'skipped_not_heading_name';
        ELSE
          PERFORM public.manage_identity_person_record('${RM_ORGANIZATION_ID}'::uuid, (a->>'person_record_id')::uuid, 'update',
            jsonb_strip_nulls(jsonb_build_object('display_name', a->>'display_name', 'category', a->>'category')), '${REPAIR_RENAME_REASON}');
          v_outcome := 'renamed';
        END IF;
      ELSE
        SELECT display_name, metadata->>'merged_into_person_record_id' INTO v_name, v_merged_into FROM public.person_records
        WHERE id = (a->>'source')::uuid AND organization_id = '${RM_ORGANIZATION_ID}'::uuid;
        SELECT display_name INTO v_target_name FROM public.person_records
        WHERE id = (a->>'target')::uuid AND organization_id = '${RM_ORGANIZATION_ID}'::uuid AND NOT (metadata ? 'merged_into_person_record_id');
        IF v_merged_into = a->>'target' THEN v_outcome := 'already_merged';
        ELSIF regexp_replace(lower(coalesce(v_name, '')), '[^a-z0-9]+', '', 'g') <> (a->>'name_compact')
          OR regexp_replace(lower(coalesce(v_target_name, '')), '[^a-z0-9]+', '', 'g') <> (a->>'name_compact') THEN v_outcome := 'skipped_name_mismatch';
        ELSE
          PERFORM public.merge_person_records('${RM_ORGANIZATION_ID}'::uuid, (a->>'source')::uuid, (a->>'target')::uuid,
            '${REPAIR_MERGE_REASON}', a->>'display_name');
          v_outcome := 'merged';
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_outcome := 'failed'; v_error := left(SQLERRM, 200);
    END;
    INSERT INTO nzta_repair_results VALUES (v_seq, a->>'kind', coalesce((a->>'person_record_id')::uuid, (a->>'source')::uuid), v_outcome, v_error);
  END LOOP;
END $repair$;`;
}

async function runRepair({ entries, commit, renameOrganisations, renameWithheld, report }) {
  const cliQuery = await seedCliQuery();
  const liveRows = cliQuery(liveSeedRowsSql())[0].out;
  const plan = planNameRepair(entries, liveRows, { renameOrganisations, renameWithheld });
  const results = [];
  // A group's renames and merges share one transaction so the merge guards see the new names.
  const batches = [];
  for (const group of plan.groups) {
    const last = batches.at(-1);
    if (last && last.length + group.length <= 60) last.push(...group);
    else batches.push([...group]);
  }
  for (const batch of batches) {
    const rows = cliQuery(`BEGIN;\n${CLAIMS}\n${repairSql(batch)}
SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.seq), '[]'::jsonb) AS out FROM nzta_repair_results r;\n${commit ? 'COMMIT' : 'ROLLBACK'};`);
    results.push(...rows[0].out);
    console.log(`${commit ? 'repaired' : 'dry-run checked'} ${results.length}/${plan.groups.flat().length} actions`);
  }
  const tally = results.reduce((counts, row) => {
    const key = `${row.kind}:${row.outcome}`;
    return { ...counts, [key]: (counts[key] ?? 0) + 1 };
  }, {});
  const errors = results.filter((row) => row.error).reduce((counts, row) => ({ ...counts, [row.error]: (counts[row.error] ?? 0) + 1 }), {});
  const summary = { mode: commit ? 'committed' : 'dry_run_rolled_back', ...plan.summary, outcomes: tally, errors };
  if (report) {
    if (path.resolve(report).startsWith(path.resolve('.'))) throw new Error('The repair report must live outside the repository');
    writeFileSync(report, JSON.stringify({ summary, results }, null, 2));
  }
  return summary;
}

async function main() {
  const cache = argument('--cache');
  if (!cache) throw new Error('Use --cache <local jsonl outside the repository> with --ocr, --plan or --apply');
  if (path.resolve(cache).startsWith(path.resolve('.'))) throw new Error('The OCR cache holds personal information and must live outside the repository');
  if (process.argv.includes('--ocr')) {
    const roots = (argument('--roots') ?? '').split(';').filter(Boolean);
    if (roots.length === 0 || roots.some((root) => !existsSync(root))) throw new Error('--roots "<folder>;<folder>" must list existing screenshot folders');
    const limit = Number(argument('--limit') ?? 100000);
    const workers = Math.min(Math.max(Number(argument('--workers') ?? 3), 1), 16);
    console.log(JSON.stringify(await runOcr({ roots, cache, limit, workers })));
    return;
  }
  if (process.argv.includes('--reextract')) {
    const output = argument('--output');
    if (!output || path.resolve(output).startsWith(path.resolve('.'))) throw new Error('--reextract needs --output <local jsonl outside the repository>');
    const entries = readJsonLines(cache);
    const rewritten = entries.map((entry) => (Array.isArray(entry.ocr_variants) ? { ...entry, ...extractEntry(entry.ocr_variants) } : entry));
    writeFileSync(output, rewritten.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    console.log(JSON.stringify({ entries: entries.length, reextracted: entries.filter((entry) => Array.isArray(entry.ocr_variants)).length }));
    return;
  }
  if (process.argv.includes('--plan')) {
    const plan = buildPlan(readJsonLines(cache));
    const output = argument('--output');
    if (output) {
      if (path.resolve(output).startsWith(path.resolve('.'))) throw new Error('The plan holds personal information and must live outside the repository');
      writeFileSync(output, JSON.stringify(plan, null, 2));
    }
    console.log(JSON.stringify(plan.summary, null, 2));
    return;
  }
  if (process.argv.includes('--apply')) {
    const plan = buildPlan(readJsonLines(cache));
    const limitPeople = argument('--limit-people') ? Number(argument('--limit-people')) : undefined;
    console.log(JSON.stringify(await runApply({ plan, commit: process.argv.includes('--commit'), limitPeople, report: argument('--report') }), null, 2));
    return;
  }
  if (process.argv.includes('--repair-names')) {
    const options = { commit: process.argv.includes('--commit'), renameOrganisations: process.argv.includes('--rename-organisations'),
      renameWithheld: process.argv.includes('--rename-withheld') };
    if (process.argv.includes('--plan-only')) {
      const cliQuery = await seedCliQuery();
      const plan = planNameRepair(readJsonLines(cache), cliQuery(liveSeedRowsSql())[0].out, options);
      const report = argument('--report');
      if (report) {
        if (path.resolve(report).startsWith(path.resolve('.'))) throw new Error('The repair plan must live outside the repository');
        writeFileSync(report, JSON.stringify(plan, null, 2));
      }
      console.log(JSON.stringify(plan.summary, null, 2));
      return;
    }
    console.log(JSON.stringify(await runRepair({ entries: readJsonLines(cache), ...options, report: argument('--report') }), null, 2));
    return;
  }
  throw new Error('Choose --ocr, --reextract, --plan, --repair-names or --apply');
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-nzta-mvr-people.mjs')) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
