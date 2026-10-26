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
  if (!fields.display_name) reasons.push('name_not_read');
  if (!fields.query_completed_at) reasons.push('query_date_not_read');
  const plateMatch = entry.parsed ? confirmPlate(entry.parsed.plate, entry.plate_verification) : null;
  if (entry.parsed && !plateMatch) reasons.push('plate_not_confirmed_by_ocr');
  if (fields.display_name && ORGANISATION_NAME.test(fields.display_name)) reasons.push('registered_to_organisation');
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

// Asynchronous so the --workers slots genuinely overlap.
async function ocrInContainer(file, slot) {
  const remote = `/tmp/nzta-ocr-${process.pid}-${slot}${path.extname(file).toLowerCase()}`;
  await execFileAsync('docker', ['cp', file, `${CONTAINER}:${remote}`]);
  try {
    return await Promise.all([6, 11].map(async (psm) => (await execFileAsync('docker', ['exec', CONTAINER, 'tesseract', remote, 'stdout', '--psm', String(psm)], {
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
        const { fields, identifier_verification: verification } = extractIdentityFieldsConsensus(variants, 'nzta_mvr_record');
        if (fields.vehicle_colour) fields.vehicle_colour = cleanColour(fields.vehicle_colour);
        appendFileSync(cache, `${JSON.stringify({
          path: file.path, name: file.name, size: file.size, parsed: file.parsed, sha256: await sha256(file.path),
          fields, plate_verification: verification?.plate_number ?? null, ocr_at: new Date().toISOString(),
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
 * Register, approve and (for each plate's latest screenshot) link the owner. Screenshots
 * run oldest first so later NZTA checks win the canonical vehicle facts, as they did in
 * real life. A failed approval leaves the evidence in the admin review queue, not lost.
 */
export function screenshotsSql(screenshots, { dryRun }) {
  return `CREATE TEMP TABLE IF NOT EXISTS nzta_seed_people (key_hash text PRIMARY KEY, person_record_id uuid, created boolean, error text);
CREATE TEMP TABLE IF NOT EXISTS nzta_seed_results (sha text PRIMARY KEY, outcome text, person_record_id uuid, identity_document_id uuid, owner_linked boolean, error text);
DO $seed$
DECLARE s jsonb; v_person uuid; v_path text; v_doc uuid; v_query timestamptz; v_newer timestamptz; v_vehicle uuid;
  v_result jsonb; v_outcome text; v_error text; v_linked boolean;
BEGIN
  FOR s IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(screenshots), 'seed_shots')}) LOOP
    v_doc := NULL; v_outcome := NULL; v_error := NULL; v_linked := false;
    v_person := coalesce((s->>'person_record_id')::uuid, (SELECT person_record_id FROM nzta_seed_people WHERE key_hash = s->>'key_hash'));
    IF EXISTS (SELECT 1 FROM public.evidence_items e WHERE e.organization_id = '${RM_ORGANIZATION_ID}'::uuid
        AND e.module_key = 'identity_registry' AND e.sha256_hash = s->>'sha') THEN
      INSERT INTO nzta_seed_results VALUES (s->>'sha', 'already_present', v_person, NULL, false, NULL) ON CONFLICT (sha) DO NOTHING;
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
      WHERE cv.plate_number = public.normalize_plate_number(s->'approved'->>'plate_number');
      IF v_newer IS NOT NULL AND v_newer > v_query THEN
        v_outcome := 'held_newer_vehicle_check';
      ELSE
        BEGIN
          v_result := public.review_nzta_mvr_identity_evidence(v_doc, 'approve',
            (s->'approved') || jsonb_build_object('query_completed_at', v_query), '${SOURCE_RULING}');
          v_outcome := 'approved';
          v_vehicle := (v_result->>'canonical_vehicle_id')::uuid;
          IF (s->>'current_owner')::boolean AND NOT EXISTS (
            SELECT 1 FROM public.vehicle_identity_checks c
            WHERE c.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND c.canonical_vehicle_id = v_vehicle
              AND c.identity_document_id <> v_doc AND c.checked_at > v_query) THEN
            PERFORM public.record_vehicle_person('${RM_ORGANIZATION_ID}'::uuid, v_vehicle, v_person, NULL, 'owner', 'nzta_mvr',
              'Latest R&M NZTA Motochek screenshot for this plate. ${SOURCE_RULING}');
            v_linked := true;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_outcome := 'held_for_review';
          v_error := left(SQLERRM, 200);
        END;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_outcome := 'failed';
      v_error := left(SQLERRM, 200);
      v_doc := NULL;
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

async function runApply({ plan, commit, limitPeople, report }) {
  const { cliQuery: rawQuery } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const cliQuery = (sql) => {
    try { return rawQuery(sql); } catch (error) {
      // Postgres echoes the failing line, which can quote seed data; keep the full text in a local file only.
      const text = String(error.stderr || '') + String(error.stdout || '') + String(error.message);
      if (process.env.NZTA_SEED_ERROR_LOG) writeFileSync(process.env.NZTA_SEED_ERROR_LOG, text);
      const message = text.split('\n').find((line) => /ERROR|error:/i.test(line)) ?? 'query failed';
      throw new Error(message.slice(0, 300));
    }
  };
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

async function main() {
  const cache = argument('--cache');
  if (!cache) throw new Error('Use --cache <local jsonl outside the repository> with --ocr, --plan or --apply');
  if (path.resolve(cache).startsWith(path.resolve('.'))) throw new Error('The OCR cache holds personal information and must live outside the repository');
  if (process.argv.includes('--ocr')) {
    const roots = (argument('--roots') ?? '').split(';').filter(Boolean);
    if (roots.length === 0 || roots.some((root) => !existsSync(root))) throw new Error('--roots "<folder>;<folder>" must list existing screenshot folders');
    const limit = Number(argument('--limit') ?? 100000);
    const workers = Math.min(Math.max(Number(argument('--workers') ?? 3), 1), 8);
    console.log(JSON.stringify(await runOcr({ roots, cache, limit, workers })));
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
  throw new Error('Choose --ocr, --plan or --apply');
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-nzta-mvr-people.mjs')) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
