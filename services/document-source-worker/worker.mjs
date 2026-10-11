import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = required('SUPABASE_URL').replace(/\/+$/, '');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
const sourceAlias = required('BOB_DOCUMENT_SOURCE_ALIAS');
const sourceRoot = path.resolve(required('DOCUMENT_SOURCE_ROOT'));
const workerId = process.env.DOCUMENT_SOURCE_WORKER_ID?.trim() || `document-source-${randomUUID()}`;
const pollMs = boundedInteger(process.env.DOCUMENT_SOURCE_POLL_MS, 10_000, 1_000, 60_000);
const batchSize = boundedInteger(process.env.DOCUMENT_SOURCE_BATCH_SIZE, 250, 25, 1_000);
const hashLimitBytes = boundedInteger(process.env.DOCUMENT_SOURCE_HASH_LIMIT_BYTES, 104_857_600, 1_048_576, 1_073_741_824);
const leaseSeconds = boundedInteger(process.env.DOCUMENT_SOURCE_LEASE_SECONDS, 180, 30, 600);

const supportedExtensions = new Set(['.csv', '.docx', '.md', '.pdf', '.tsv', '.txt', '.xls', '.xlsx']);
const partialExtensions = new Set([
  '.asf', '.avi', '.dav', '.doc', '.jpeg', '.jpg', '.mov', '.mp4', '.msg', '.png', '.ppt',
  '.pptx', '.rtf', '.tif', '.tiff', '.webp',
]);
const quarantineExtensions = new Set([
  '.7z', '.apk', '.bin', '.db', '.exe', '.iqy', '.lnk', '.mdb', '.ost', '.pst', '.rar', '.url', '.zip',
]);
const excludedExtensions = new Set(['.crdownload', '.download', '.part', '.tmp']);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function restHeaders(extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: restHeaders(options.headers),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function claimRun() {
  const result = await jsonRequest(`${baseUrl}/rest/v1/rpc/claim_document_source_ingestion`, {
    method: 'POST',
    body: JSON.stringify({ p_worker_id: workerId, p_lease_seconds: leaseSeconds }),
  });
  const candidate = Array.isArray(result) ? (result[0] ?? null) : result;
  return candidate?.id && candidate?.lease_token ? candidate : null;
}

async function loadSource(sourceId) {
  const rows = await jsonRequest(
    `${baseUrl}/rest/v1/document_reference_sources?select=id,organization_id,location_ref,source_kind,approval_status,is_active&id=eq.${encodeURIComponent(sourceId)}&limit=1`,
  );
  return rows?.[0] ?? null;
}

async function loadRunStatus(runId) {
  const rows = await jsonRequest(
    `${baseUrl}/rest/v1/document_source_ingestion_runs?select=status&id=eq.${encodeURIComponent(runId)}&limit=1`,
  );
  return rows?.[0]?.status ?? null;
}

async function patchRun(run, changes) {
  const rows = await jsonRequest(
    `${baseUrl}/rest/v1/document_source_ingestion_runs?id=eq.${encodeURIComponent(run.id)}&lease_token=eq.${encodeURIComponent(run.lease_token)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(changes),
    },
  );
  if (!rows?.length) throw new Error('Document source run lease was lost');
  return rows[0];
}

async function insertEvent(run, eventType, counts, message) {
  await jsonRequest(`${baseUrl}/rest/v1/document_source_run_events`, {
    method: 'POST',
    body: JSON.stringify({
      organization_id: run.organization_id,
      run_id: run.id,
      event_type: eventType,
      phase: 'enumeration',
      counts_json: counts,
      message_redacted: message,
    }),
  });
}

async function upsertEntries(entries) {
  if (!entries.length) return [];
  return jsonRequest(
    `${baseUrl}/rest/v1/document_source_manifest_entries?on_conflict=run_id,relative_path`,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(entries),
    },
  );
}

async function* walkDirectory(root, relativeDirectory = '') {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const directory = await opendir(absoluteDirectory);
  const entries = [];
  for await (const entry of directory) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en-NZ'));

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walkDirectory(root, relativePath);
    } else if (entry.isFile()) {
      yield relativePath;
    }
  }
}

function classifyFile(relativePath, sizeBytes) {
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).toLowerCase();
  const officeLock = fileName.startsWith('~$');
  const restricted = /(^|[\\/])(hr|human resources|legal|payroll|disciplin|personnel|employment|medical)([\\/]|$)/i.test(relativePath);

  if (sizeBytes === 0 || officeLock || excludedExtensions.has(extension)) {
    return {
      extension,
      capabilityStatus: 'exclude',
      disposition: 'excluded',
      sensitivity: restricted ? 'restricted' : 'tenant_sensitive',
      extractionStatus: 'not_applicable',
      hashEligible: false,
    };
  }
  if (quarantineExtensions.has(extension)) {
    return {
      extension,
      capabilityStatus: extension === '.pst' || extension === '.ost' ? 'gap' : 'exclude',
      disposition: 'quarantined',
      sensitivity: restricted ? 'restricted' : 'tenant_sensitive',
      extractionStatus: 'not_applicable',
      hashEligible: false,
    };
  }
  if (supportedExtensions.has(extension)) {
    return {
      extension,
      capabilityStatus: 'supported',
      disposition: 'ready_for_extraction',
      sensitivity: restricted ? 'restricted' : 'tenant_sensitive',
      extractionStatus: 'not_started',
      hashEligible: sizeBytes <= hashLimitBytes,
    };
  }
  if (partialExtensions.has(extension)) {
    return {
      extension,
      capabilityStatus: 'partial',
      disposition: 'inventory_only',
      sensitivity: restricted ? 'restricted' : 'tenant_sensitive',
      extractionStatus: 'not_started',
      hashEligible: sizeBytes <= hashLimitBytes,
    };
  }
  return {
    extension,
    capabilityStatus: 'gap',
    disposition: 'inventory_only',
    sensitivity: restricted ? 'restricted' : 'tenant_sensitive',
    extractionStatus: 'not_started',
    hashEligible: false,
  };
}

async function hashFile(absolutePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function countsSnapshot(counts) {
  return {
    discovered_count: counts.discovered,
    hashed_count: counts.hashed,
    duplicate_count: counts.duplicate,
    supported_count: counts.supported,
    partial_count: counts.partial,
    gap_count: counts.gap,
    excluded_count: counts.excluded,
    quarantined_count: counts.quarantined,
    failed_count: counts.failed,
  };
}

async function inventory(run) {
  const source = await loadSource(run.source_id);
  if (
    !source
    || source.organization_id !== run.organization_id
    || source.location_ref !== sourceAlias
    || source.source_kind !== 'local_folder'
    || source.approval_status !== 'approved'
    || source.is_active !== true
  ) {
    throw new Error('The claimed run does not match this approved local source alias');
  }

  const rootStats = await stat(sourceRoot);
  if (!rootStats.isDirectory()) throw new Error('Configured document source root is not a directory');

  const counts = {
    discovered: Number(run.discovered_count ?? 0),
    hashed: Number(run.hashed_count ?? 0),
    duplicate: Number(run.duplicate_count ?? 0),
    supported: Number(run.supported_count ?? 0),
    partial: Number(run.partial_count ?? 0),
    gap: Number(run.gap_count ?? 0),
    excluded: Number(run.excluded_count ?? 0),
    quarantined: Number(run.quarantined_count ?? 0),
    failed: Number(run.failed_count ?? 0),
  };
  const seenHashes = new Set();
  const resumeAfter = typeof run.cursor_json?.last_relative_path === 'string'
    ? run.cursor_json.last_relative_path
    : null;
  let resumeReached = resumeAfter === null;
  let batch = [];
  let checkpointAt = counts.discovered + 5_000;

  await insertEvent(run, 'inventory_started', countsSnapshot(counts), 'Read-only source enumeration started.');

  for await (const relativeNativePath of walkDirectory(sourceRoot)) {
    const relativePath = relativeNativePath.split(path.sep).join('/');
    if (!resumeReached) {
      if (relativePath === resumeAfter) resumeReached = true;
      continue;
    }

    if (counts.discovered % 250 === 0 && await loadRunStatus(run.id) === 'cancel_requested') {
      await patchRun(run, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
        ...countsSnapshot(counts),
      });
      await insertEvent(run, 'inventory_cancelled', countsSnapshot(counts), 'Read-only source inventory cancelled.');
      return;
    }

    const absolutePath = path.join(sourceRoot, relativeNativePath);
    try {
      const fileStats = await stat(absolutePath);
      const classification = classifyFile(relativeNativePath, fileStats.size);
      let sha256 = null;
      if (classification.hashEligible) {
        sha256 = await hashFile(absolutePath);
        counts.hashed += 1;
        if (seenHashes.has(sha256)) counts.duplicate += 1;
        else seenHashes.add(sha256);
      }

      counts.discovered += 1;
      if (classification.capabilityStatus === 'exclude') counts.excluded += 1;
      else counts[classification.capabilityStatus] += 1;
      if (classification.disposition === 'quarantined') counts.quarantined += 1;
      batch.push({
        organization_id: run.organization_id,
        run_id: run.id,
        source_id: run.source_id,
        relative_path: relativePath,
        file_name: path.basename(relativeNativePath),
        extension: classification.extension || null,
        size_bytes: fileStats.size,
        modified_at: fileStats.mtime.toISOString(),
        sha256,
        capability_status: classification.capabilityStatus,
        sensitivity: classification.sensitivity,
        disposition: classification.disposition,
        extraction_status: classification.extractionStatus,
        metadata_json: {
          hash_deferred: !classification.hashEligible,
          source_version: `${fileStats.size}:${Math.trunc(fileStats.mtimeMs)}`,
        },
      });
    } catch {
      counts.discovered += 1;
      counts.failed += 1;
      batch.push({
        organization_id: run.organization_id,
        run_id: run.id,
        source_id: run.source_id,
        relative_path: relativePath,
        file_name: path.basename(relativeNativePath),
        extension: path.extname(relativeNativePath).toLowerCase() || null,
        size_bytes: 0,
        capability_status: 'gap',
        sensitivity: 'tenant_sensitive',
        disposition: 'failed',
        extraction_status: 'failed',
        error_code: 'metadata_read_failed',
        metadata_json: {},
      });
    }

    if (batch.length >= batchSize) {
      await upsertEntries(batch);
      const lastRelativePath = batch.at(-1).relative_path;
      batch = [];
      run = await patchRun(run, {
        heartbeat_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + leaseSeconds * 1_000).toISOString(),
        cursor_json: { last_relative_path: lastRelativePath },
        ...countsSnapshot(counts),
      });
      if (counts.discovered >= checkpointAt) {
        await insertEvent(run, 'inventory_checkpoint', countsSnapshot(counts), 'Read-only source inventory checkpoint saved.');
        checkpointAt = counts.discovered + 5_000;
      }
    }
  }

  if (!resumeReached) throw new Error('Saved inventory cursor was not found in the configured source');
  if (batch.length) {
    await upsertEntries(batch);
    run = await patchRun(run, {
      heartbeat_at: new Date().toISOString(),
      cursor_json: { last_relative_path: batch.at(-1).relative_path },
      ...countsSnapshot(counts),
    });
  }

  await patchRun(run, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    lease_expires_at: null,
    ...countsSnapshot(counts),
  });
  await insertEvent(run, 'inventory_completed', countsSnapshot(counts), 'Read-only source inventory completed.');
}

async function failRun(run, error) {
  const detail = error instanceof Error ? error.message : 'Unknown worker failure';
  console.error(`[document-source-worker] run ${run.id} failed: ${detail}`);
  try {
    await patchRun(run, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      lease_expires_at: null,
      error_code: 'inventory_worker_failed',
      error_detail_redacted: detail.slice(0, 500),
    });
    await insertEvent(run, 'inventory_failed', {}, 'Read-only source inventory failed. See the redacted run error.');
  } catch (patchError) {
    console.error(`[document-source-worker] could not persist failure: ${patchError instanceof Error ? patchError.message : patchError}`);
  }
}

async function main() {
  console.log(`[document-source-worker] started as ${workerId}`);
  for (;;) {
    let run = null;
    try {
      run = await claimRun();
      if (!run) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      await inventory(run);
    } catch (error) {
      if (run) await failRun(run, error);
      else console.error(`[document-source-worker] poll failed: ${error instanceof Error ? error.message : error}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

await main();
