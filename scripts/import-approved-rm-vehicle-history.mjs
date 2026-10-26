import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { validatePhotoImportEnvironment } from './rm-photo-import-config.mjs';
import {
  aucklandInstant,
  indexPhotoTargets,
  matchPhotoTarget,
  normalizePlate,
  parsePhotoName,
} from './rm-photo-matcher.mjs';

const DEFAULT_PROVIDER_ORG = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sourcePath(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Candidate leaves the governed R&M source root: ${candidate}`);
  }
  return resolvedCandidate;
}

function mimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error(`Unsupported evidence image type: ${extname(path)}`);
  }
}

function storagePath(row, sha256) {
  const sourceExtension = extname(row.relativePath).toLowerCase();
  const extension = sourceExtension === '.jpeg' ? '.jpg' : sourceExtension;
  return `org/${row.organizationId}/record-evidence/${row.recordKind ?? 'observation'}/${row.observationId}/${sha256}${extension}`;
}

// File metadata is provenance: a camera photo normally carries an EXIF block, while a CCTV
// screenshot or export does not. This is supporting evidence, not proof of origin.
export function photoProvenance(bytes, fileInfo = null) {
  const head = bytes.subarray(0, 65536).toString('latin1');
  const exif = head.includes('Exif\u0000\u0000');
  const parts = [exif ? 'camera EXIF present' : 'no camera EXIF (consistent with a CCTV screenshot or export)'];
  if (fileInfo?.size_bytes !== undefined) parts.push(`${fileInfo.size_bytes} bytes`);
  if (fileInfo?.modified_at) parts.push(`file modified ${fileInfo.modified_at}`);
  return parts.join(', ');
}

async function page(queryFactory) {
  const rows = [];
  const size = 1000;
  for (let start = 0; ; start += size) {
    const { data, error } = await queryFactory().range(start, start + size - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < size) return rows;
  }
}

export async function loadVisibleOrganizationIds(service, providerOrganizationId) {
  const ids = new Set([providerOrganizationId]);
  const descendants = await service.rpc('get_descendant_organizations', { p_root_id: providerOrganizationId });
  if (!descendants.error && Array.isArray(descendants.data)) {
    descendants.data.forEach((id) => ids.add(String(id)));
  }
  const { data, error } = await service
    .from('service_agreements')
    .select('client_organization_id')
    .eq('provider_organization_id', providerOrganizationId)
    .eq('agreement_type', 'operational')
    .eq('invitation_status', 'accepted');
  if (error) throw error;
  (data ?? []).forEach((agreement) => ids.add(agreement.client_organization_id));
  return [...ids];
}

export async function loadTargets(service, organizationIds, { includePatrolEvents = false } = {}) {
  const [targets, sites, zones, locations, events] = await Promise.all([
    page(() => service
      .from('observations')
      .select('id,organization_id,plate_number,officer_notes,observed_at,site_id,zone_id,location_id,canonical_vehicle_id,module_key,plate_source')
      .in('organization_id', organizationIds)
      .order('observed_at', { ascending: true })),
    page(() => service.from('client_sites').select('id,name').in('organization_id', organizationIds)),
    page(() => service.from('location_zones').select('id,name').in('organization_id', organizationIds)),
    page(() => service.from('locations').select('id,name').in('organization_id', organizationIds)),
    includePatrolEvents
      ? page(() => service
        .from('location_events')
        .select('id,organization_id,occurred_at,zone_id,client_site_id,reg_raw:payload->>reg_raw,plates_found:payload->>plates_found,location_raw:payload->>location_raw,reserve_raw:payload->>reserve_raw,comments:payload->>comments')
        .in('organization_id', organizationIds)
        .eq('source', 'rm_patrol_log_import')
        .order('id', { ascending: true }))
      : Promise.resolve([]),
  ]);
  const aliasesByPlace = new Map();
  for (const place of [...sites, ...zones, ...locations]) {
    aliasesByPlace.set(place.id, place.name ? [place.name] : []);
  }
  const withAliases = targets.map((target) => ({
    ...target,
    place_aliases: [target.site_id, target.zone_id, target.location_id]
      .flatMap((id) => aliasesByPlace.get(id) ?? []),
  }));
  const byMinute = indexPhotoTargets(withAliases);
  // Patrol log entries are a fallback index: observations are mirrored into location_events,
  // so matching both at once would make every sighting look ambiguous.
  const eventsByMinute = indexPhotoTargets(events.map((event) => ({
    id: event.id,
    organization_id: event.organization_id,
    observed_at: event.occurred_at,
    plate_number: event.reg_raw,
    officer_notes: [event.plates_found, event.comments].filter(Boolean).join(' '),
    place_aliases: [...(aliasesByPlace.get(event.zone_id ?? event.client_site_id) ?? []), event.location_raw, event.reserve_raw]
      .filter(Boolean),
    recordKind: 'location_event',
  })));
  return { targets, byMinute, eventsByMinute };
}

// Classifies one source photo: unsupported, unnamed (no structured date/time), unmatched,
// ambiguous, missing, or a single exact observation match ready to attach.
export async function classifyPhoto(relativePath, sourceRoot, byMinute, fileName = null, eventsByMinute = null) {
  const extension = extname(relativePath).toLowerCase();
  if (!/^photos[\\/]/i.test(relativePath) || !SUPPORTED_EXTENSIONS.has(extension)) return { status: 'unsupported' };
  const parsed = parsePhotoName(fileName ?? relativePath);
  if (!parsed) return { status: 'unnamed' };
  let match = matchPhotoTarget(parsed, relativePath, byMinute);
  if (match.status === 'unmatched' && eventsByMinute) match = matchPhotoTarget(parsed, relativePath, eventsByMinute);
  if (match.status === 'unmatched' || match.status === 'ambiguous') return { status: match.status, parsed };
  const localPath = sourcePath(sourceRoot, relativePath);
  try {
    await access(localPath);
  } catch {
    return { status: 'missing' };
  }
  const capturedAt = aucklandInstant(parsed);
  if (!capturedAt) return { status: 'ambiguous' };
  return {
    status: 'matched',
    row: {
      relativePath,
      localPath,
      parsed,
      recordKind: match.target.recordKind ?? 'observation',
      observationId: match.target.id,
      organizationId: match.target.organization_id,
      plate: parsed.plate ?? normalizePlate(match.target.plate_number),
      matchType: match.matchType,
      capturedAt,
    },
  };
}

async function matchPhotos(inventoryPath, sourceRoot, byMinute) {
  const matched = [];
  let supportedPhotos = 0;
  let namedPhotos = 0;
  let unmatched = 0;
  let ambiguous = 0;
  const seen = new Set();
  const input = createInterface({
    input: createReadStream(inventoryPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of input) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const relativePath = String(row.relative_path ?? '');
    const result = await classifyPhoto(relativePath, sourceRoot, byMinute, row.file_name ?? null);
    if (result.status === 'unsupported') continue;
    supportedPhotos += 1;
    if (result.status === 'unnamed') continue;
    namedPhotos += 1;
    if (result.status === 'unmatched' || result.status === 'missing') {
      unmatched += 1;
      continue;
    }
    if (result.status === 'ambiguous') {
      ambiguous += 1;
      continue;
    }
    const key = `${relativePath}:${result.row.observationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(result.row);
  }
  return { matched, supportedPhotos, namedPhotos, unmatched, ambiguous };
}

// Uploads (or reuses) one matched photo and attaches it through the governed RPC.
// Returns the evidence hash and storage path so callers can record a per-photo receipt.
export async function attachMatchedPhoto(service, governed, row) {
  const bytes = await readFile(row.localPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await service
    .from('evidence_items')
    .select('id,storage_path')
    .eq('organization_id', row.organizationId)
    .eq('evidence_kind', 'photo')
    .eq('sha256_hash', sha256)
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  let destination = existing.data?.storage_path || storagePath(row, sha256);
  let uploadedThisRun = false;
  let reused = false;
  let alreadyLinked = false;
  if (existing.data?.storage_path) {
    reused = true;
    if ((row.recordKind ?? 'observation') === 'observation') {
      const support = await service
        .from('observation_supporting_evidence')
        .select('id')
        .eq('organization_id', row.organizationId)
        .eq('observation_id', row.observationId)
        .eq('evidence_kind', 'external_photo')
        .eq('storage_path', destination)
        .limit(1)
        .maybeSingle();
      if (support.error) throw support.error;
      alreadyLinked = Boolean(support.data);
    }
  } else {
    const upload = await governed.storage.from('bob-uploads').upload(
      destination,
      new Blob([bytes], { type: mimeType(row.localPath) }),
      { upsert: false, contentType: mimeType(row.localPath) },
    );
    const existed = Boolean(upload.error && /already exists|duplicate/i.test(upload.error.message));
    if (upload.error && !existed) throw upload.error;
    if (existed) reused = true;
    else uploadedThisRun = true;
  }

  const sourceReference = `local://rm/remsec-documents/${row.relativePath.replaceAll('\\', '/')}`;
  const description = `Approved working-file photo${row.plate ? ` for ${row.plate}` : ''}`;
  const sourceNote = `${sourceReference}; exact Auckland-local date/minute matched by ${row.matchType}; ${photoProvenance(bytes, row.fileInfo)}`;
  const result = await governed.rpc('attach_external_photo_to_record', {
    p_record_kind: row.recordKind ?? 'observation',
    p_record_id: row.observationId,
    p_storage_path: destination,
    p_sha256: sha256,
    p_description: description,
    p_source_note: sourceNote,
    p_original_name: basename(row.relativePath),
    p_captured_at: row.capturedAt,
  });
  if (result.error) {
    if (uploadedThisRun) await governed.storage.from('bob-uploads').remove([destination]);
    throw new Error(`${row.relativePath}: ${result.error.message}`);
  }
  const registered = await service
    .from('evidence_items')
    .select('storage_path')
    .eq('organization_id', row.organizationId)
    .eq('evidence_kind', 'photo')
    .eq('sha256_hash', sha256)
    .limit(1)
    .single();
  if (registered.error) throw registered.error;
  let discardedDuplicateUpload = false;
  if (uploadedThisRun && registered.data.storage_path !== destination) {
    await governed.storage.from('bob-uploads').remove([destination]);
    destination = registered.data.storage_path;
    discardedDuplicateUpload = true;
  }
  return { sha256, storage_path: destination, uploaded: uploadedThisRun && !discardedDuplicateUpload,
    reused, already_linked: alreadyLinked, discarded_duplicate_upload: discardedDuplicateUpload };
}

async function runWorkers(rows, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (index < rows.length) {
      const current = rows[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const inventoryPath = requiredArgument('--inventory');
  const sourceRoot = requiredArgument('--source-root');
  const providerOrganizationId = argument('--provider-org', DEFAULT_PROVIDER_ORG);
  const concurrency = Number(argument('--concurrency', '4'));
  const limit = argument('--limit') ? Number(argument('--limit')) : null;
  const apply = process.argv.includes('--apply');
  if (argument('--tolerance-minutes') !== null) throw new Error('Photo matching uses the exact Auckland-local minute; --tolerance-minutes is no longer supported');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error('--concurrency must be an integer from 1 to 12');
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const actorEmail = process.env.RM_PHOTO_IMPORT_ACTOR_EMAIL;
  const actorPassword = process.env.RM_PHOTO_IMPORT_ACTOR_PASSWORD;
  validatePhotoImportEnvironment({ apply, url, serviceRole, actorEmail, actorPassword });

  const service = createClient(url, serviceRole, { auth: { persistSession: false } });
  let governed = null;
  if (apply) {
    governed = createClient(url, serviceRole, { auth: { persistSession: false } });
    const { error: authError } = await governed.auth.signInWithPassword({ email: actorEmail, password: actorPassword });
    if (authError) throw new Error(`Dedicated photo importer authentication failed: ${authError.message}`);
  }

  const organizationIds = await loadVisibleOrganizationIds(service, providerOrganizationId);
  const { targets, byMinute } = await loadTargets(service, organizationIds);
  const matching = await matchPhotos(inventoryPath, sourceRoot, byMinute);
  const selected = limit === null ? matching.matched : matching.matched.slice(0, limit);

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      structuredVehicleObservations: targets.length,
      supportedCorpusPhotos: matching.supportedPhotos,
      filenameStructuredPhotos: matching.namedPhotos,
      exactObservationMatches: matching.matched.length,
      ambiguousMatchesHeld: matching.ambiguous,
      unmatchedStructuredPhotos: matching.unmatched,
      selected: selected.length,
      matchingRule: 'exact Auckland-local date and minute plus filename rego or exact folder place alias',
    }));
    return;
  }

  let uploaded = 0;
  let reused = 0;
  let attached = 0;
  let discardedDuplicateUploads = 0;
  let alreadyLinked = 0;
  const observationHashPairs = new Set();
  await runWorkers(selected, concurrency, async (row) => {
    const outcome = await attachMatchedPhoto(service, governed, row);
    observationHashPairs.add(`${row.observationId}:${outcome.sha256}`);
    if (outcome.uploaded) uploaded += 1;
    if (outcome.reused) reused += 1;
    if (outcome.already_linked) alreadyLinked += 1;
    if (outcome.discarded_duplicate_upload) discardedDuplicateUploads += 1;
    attached += 1;
  });

  console.log(JSON.stringify({
    mode: 'apply',
    structuredVehicleObservations: targets.length,
    exactObservationMatches: matching.matched.length,
    ambiguousMatchesHeld: matching.ambiguous,
    unmatchedStructuredPhotos: matching.unmatched,
    selected: selected.length,
    uploaded,
    reused,
    discardedDuplicateUploads,
    uniqueObservationHashPairs: observationHashPairs.size,
    alreadyLinked,
    attached,
  }));
  await governed.auth.signOut();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Photo import failed');
    process.exitCode = 1;
  });
}
