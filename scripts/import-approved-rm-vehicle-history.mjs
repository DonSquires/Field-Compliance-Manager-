import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_PROVIDER_ORG = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PLATE_PATTERN = '(?:[A-Z]{2,3}[0-9]{2,4}|[0-9]{1,3}[A-Z]{2,3})';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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

function parsePhotoName(fileName) {
  const stem = basename(fileName, extname(fileName)).toUpperCase();
  const dateFirst = new RegExp(`(?:^|[^0-9])([0-9]{6})[ _-]+([0-9]{4,6})[ _-]+(${PLATE_PATTERN})(?:[^A-Z0-9]|$)`).exec(stem);
  const plateFirst = new RegExp(`(?:^|[^A-Z0-9])(${PLATE_PATTERN})[ _-]+([0-9]{6})[ _-]+([0-9]{4,6})(?:[^0-9]|$)`).exec(stem);
  const match = dateFirst
    ? { date: dateFirst[1], time: dateFirst[2], plate: dateFirst[3] }
    : plateFirst
      ? { plate: plateFirst[1], date: plateFirst[2], time: plateFirst[3] }
      : null;
  if (!match) return null;

  const year = 2000 + Number(match.date.slice(0, 2));
  const month = Number(match.date.slice(2, 4));
  const day = Number(match.date.slice(4, 6));
  const paddedTime = match.time.padEnd(6, '0');
  const hour = Number(paddedTime.slice(0, 2));
  const minute = Number(paddedTime.slice(2, 4));
  const second = Number(paddedTime.slice(4, 6));
  const clock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    clock.getUTCFullYear() !== year
    || clock.getUTCMonth() !== month - 1
    || clock.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;

  return {
    plate: normalizePlate(match.plate),
    localClockMs: clock.getTime(),
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function aucklandClockMs(instant) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'Pacific/Auckland',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
}

function sourceClockDeltas(observedAt, localClockMs) {
  const instant = new Date(observedAt);
  return [
    Math.abs((instant.getTime() + 12 * 60 * 60 * 1000) - localClockMs),
    Math.abs(aucklandClockMs(instant) - localClockMs),
  ];
}

function nzInstant(parsed) {
  for (const offsetHours of [13, 12]) {
    const candidate = new Date(parsed.localClockMs - offsetHours * 60 * 60 * 1000);
    if (aucklandClockMs(candidate) === parsed.localClockMs) return candidate.toISOString();
  }
  throw new Error(`Could not resolve Pacific/Auckland time for ${parsed.year}-${parsed.month}-${parsed.day}`);
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
  return `org/${row.organizationId}/record-evidence/observation/${row.observationId}/${sha256}${extension}`;
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

async function loadVisibleOrganizationIds(service, providerOrganizationId) {
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

async function loadTargets(service, organizationIds) {
  const targets = await page(() => service
    .from('observations')
    .select('id,organization_id,plate_number,observed_at,canonical_vehicle_id,module_key,plate_source')
    .in('organization_id', organizationIds)
    .not('canonical_vehicle_id', 'is', null)
    .not('plate_number', 'is', null)
    .order('observed_at', { ascending: true }));
  const byPlate = new Map();
  for (const target of targets) {
    const plate = normalizePlate(target.plate_number);
    if (!plate) continue;
    const rows = byPlate.get(plate) ?? [];
    rows.push(target);
    byPlate.set(plate, rows);
  }
  return { targets, byPlate };
}

async function matchPhotos(inventoryPath, sourceRoot, byPlate, toleranceMinutes) {
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
    const extension = extname(relativePath).toLowerCase();
    if (!/^photos[\\/]/i.test(relativePath) || !SUPPORTED_EXTENSIONS.has(extension)) continue;
    supportedPhotos += 1;
    const parsed = parsePhotoName(row.file_name ?? relativePath);
    if (!parsed) continue;
    namedPhotos += 1;
    const candidates = byPlate.get(parsed.plate) ?? [];
    const scored = candidates.map((target) => ({
      target,
      deltaMs: Math.min(...sourceClockDeltas(target.observed_at, parsed.localClockMs)),
    })).filter((candidate) => candidate.deltaMs <= toleranceMinutes * 60 * 1000)
      .sort((a, b) => a.deltaMs - b.deltaMs);
    if (scored.length === 0) {
      unmatched += 1;
      continue;
    }
    if (scored.length > 1 && Math.abs(scored[0].deltaMs - scored[1].deltaMs) < 60 * 1000) {
      ambiguous += 1;
      continue;
    }
    const key = `${relativePath}:${scored[0].target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const localPath = sourcePath(sourceRoot, relativePath);
    try {
      await access(localPath);
    } catch {
      unmatched += 1;
      continue;
    }
    matched.push({
      relativePath,
      localPath,
      parsed,
      observationId: scored[0].target.id,
      organizationId: scored[0].target.organization_id,
      plate: parsed.plate,
      deltaMs: scored[0].deltaMs,
      capturedAt: nzInstant(parsed),
    });
  }
  return { matched, supportedPhotos, namedPhotos, unmatched, ambiguous };
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
  const toleranceMinutes = Number(argument('--tolerance-minutes', '15'));
  const concurrency = Number(argument('--concurrency', '4'));
  const limit = argument('--limit') ? Number(argument('--limit')) : null;
  const apply = process.argv.includes('--apply');
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0 || toleranceMinutes > 120) {
    throw new Error('--tolerance-minutes must be between 0 and 120');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error('--concurrency must be an integer from 1 to 12');
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.username_email;
  const password = process.env.username_password;
  if (!url || !serviceRole || !email || !password) {
    throw new Error('Supabase URL, service role, and governed user credentials are required');
  }

  const service = createClient(url, serviceRole, { auth: { persistSession: false } });
  const governed = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { error: authError } = await governed.auth.signInWithPassword({ email, password });
  if (authError) throw new Error(`Governed user authentication failed: ${authError.message}`);

  let promotion = null;
  if (apply) {
    promotion = {
      batches: 0,
      candidates: 0,
      observations_inserted: 0,
      observations_matched: 0,
      audit_receipts_inserted: 0,
    };
    for (let batch = 0; batch < 1000; batch += 1) {
      const result = await governed.rpc('promote_approved_rnm_vehicle_mentions', {
        p_provider_organization_id: providerOrganizationId,
      });
      if (result.error) throw result.error;
      const values = result.data ?? {};
      promotion.batches += 1;
      promotion.candidates += Number(values.candidates ?? 0);
      promotion.observations_inserted += Number(values.observations_inserted ?? 0);
      promotion.observations_matched += Number(values.observations_matched ?? 0);
      promotion.audit_receipts_inserted += Number(values.audit_receipts_inserted ?? 0);
      if (Number(values.candidates ?? 0) === 0) break;
      if (batch === 999) throw new Error('Approved vehicle promotion did not drain after 1000 batches');
    }
  }

  const organizationIds = await loadVisibleOrganizationIds(service, providerOrganizationId);
  const { targets, byPlate } = await loadTargets(service, organizationIds);
  const matching = await matchPhotos(inventoryPath, sourceRoot, byPlate, toleranceMinutes);
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
      toleranceMinutes,
    }));
    await governed.auth.signOut();
    return;
  }

  let uploaded = 0;
  let reused = 0;
  let attached = 0;
  let discardedDuplicateUploads = 0;
  let alreadyLinked = 0;
  const observationHashPairs = new Set();
  await runWorkers(selected, concurrency, async (row) => {
    const bytes = await readFile(row.localPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    observationHashPairs.add(`${row.observationId}:${sha256}`);
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
    if (existing.data?.storage_path) {
      reused += 1;
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
      if (support.data) alreadyLinked += 1;
    } else {
      const upload = await governed.storage.from('bob-uploads').upload(
        destination,
        new Blob([bytes], { type: mimeType(row.localPath) }),
        { upsert: false, contentType: mimeType(row.localPath) },
      );
      const existed = Boolean(upload.error && /already exists|duplicate/i.test(upload.error.message));
      if (upload.error && !existed) throw upload.error;
      if (existed) reused += 1;
      else {
        uploaded += 1;
        uploadedThisRun = true;
      }
    }

    const sourceReference = `local://rm/remsec-documents/${row.relativePath.replaceAll('\\', '/')}`;
    const description = `Approved working-file photo for ${row.plate}`;
    const sourceNote = `${sourceReference}; filename plate/date/time matched to the approved observation within ${(row.deltaMs / 60000).toFixed(2)} minutes`;
    const result = await governed.rpc('attach_external_photo_to_record', {
      p_record_kind: 'observation',
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
    if (uploadedThisRun && registered.data.storage_path !== destination) {
      await governed.storage.from('bob-uploads').remove([destination]);
      destination = registered.data.storage_path;
      discardedDuplicateUploads += 1;
    }
    attached += 1;
  });

  console.log(JSON.stringify({
    mode: 'apply',
    promotion,
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

await main();
