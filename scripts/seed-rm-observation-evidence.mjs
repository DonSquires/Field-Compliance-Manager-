import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      throw new Error(`Unsupported evidence image type: ${extname(path) || 'none'}`);
  }
}

function sourceCaptureIso(row) {
  const offset = String(row.observed_at).match(/([+-])(\d{2})(?::?(\d{2}))?$/);
  const suffix = offset ? `${offset[1]}${offset[2]}:${offset[3] ?? '00'}` : 'Z';
  return `${row.capture_local}${suffix}`;
}

function storagePath(row, sha256) {
  const extension = extname(row.relative_path).toLowerCase() === '.jpeg' ? '.jpg' : extname(row.relative_path).toLowerCase();
  return `org/${row.organization_id}/record-evidence/observation/${row.observation_id}/${sha256}${extension}`;
}

function assertWithinRoot(sourceRoot, candidatePath) {
  const resolvedRoot = resolve(sourceRoot);
  const resolvedCandidate = resolve(resolvedRoot, candidatePath);
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`Candidate path leaves the governed source root: ${candidatePath}`);
  }
  return resolvedCandidate;
}

async function loadCandidates(manifestPath, limit) {
  const lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const rows = lines.slice(1).map((line) => JSON.parse(line));
  const unique = new Map();
  for (const row of rows) {
    if (!unique.has(row.observation_id)) unique.set(row.observation_id, row);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

async function main() {
  const manifestPath = requiredArgument('--manifest');
  const sourceRoot = requiredArgument('--source-root');
  const limit = Number(argument('--limit', '50'));
  const apply = process.argv.includes('--apply');
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('--limit must be an integer from 1 to 250');

  const url = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.username_email;
  const password = process.env.username_password;
  if (!url || !apiKey || !email || !password) throw new Error('Supabase URL, API key, and governed user credentials are required');

  const candidates = await loadCandidates(manifestPath, limit);
  const prepared = [];
  for (const row of candidates) {
    const localPath = assertWithinRoot(sourceRoot, row.relative_path);
    const bytes = await readFile(localPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    prepared.push({
      ...row,
      localPath,
      bytes,
      sha256,
      capturedAt: sourceCaptureIso(row),
      storagePath: storagePath(row, sha256),
    });
  }

  const client = createClient(url, apiKey, { auth: { persistSession: false } });
  const { error: authError } = await client.auth.signInWithPassword({ email, password });
  if (authError) throw new Error(`Governed user authentication failed: ${authError.message}`);

  const observationIds = prepared.map((row) => row.observation_id);
  const { data: visible, error: visibleError } = await client
    .from('observations')
    .select('id,organization_id,plate_number,observed_at')
    .in('id', observationIds);
  if (visibleError) throw visibleError;
  const visibleById = new Map((visible ?? []).map((row) => [row.id, row]));
  for (const row of prepared) {
    const record = visibleById.get(row.observation_id);
    if (!record) throw new Error('At least one selected observation is unavailable to the governed user');
    if (record.organization_id !== row.organization_id) throw new Error('Observation tenant does not match the candidate manifest');
    if (String(record.plate_number ?? '').toUpperCase() !== String(row.plate).toUpperCase()) {
      throw new Error('Observation plate does not match the candidate manifest');
    }
  }

  if (!apply) {
    const bytes = prepared.reduce((total, row) => total + row.bytes.length, 0);
    console.log(JSON.stringify({ mode: 'dry-run', selected: prepared.length, bytes, allRecordsVisible: true }));
    await client.auth.signOut();
    return;
  }

  let uploaded = 0;
  let reused = 0;
  let attached = 0;
  for (const row of prepared) {
    const upload = await client.storage.from('bob-uploads').upload(
      row.storagePath,
      new Blob([row.bytes], { type: mimeType(row.localPath) }),
      { upsert: false, contentType: mimeType(row.localPath) },
    );
    const existed = Boolean(upload.error && /already exists|duplicate/i.test(upload.error.message));
    if (upload.error && !existed) throw upload.error;
    if (existed) reused += 1;
    else uploaded += 1;

    const sourceReference = `local://rm/remsec-documents/${String(row.relative_path).replaceAll('\\', '/')}`;
    const description = `Source photo matched to ${row.plate} at ${row.place}`;
    const sourceNote = `${sourceReference}; explicit plate, same date, place token, and ${Number(row.minutes_delta).toFixed(2)} minute timestamp match`;
    const { data: evidenceId, error: attachError } = await client.rpc('attach_external_photo_to_record', {
      p_record_kind: 'observation',
      p_record_id: row.observation_id,
      p_storage_path: row.storagePath,
      p_sha256: row.sha256,
      p_description: description,
      p_source_note: sourceNote,
      p_original_name: basename(row.relative_path),
      p_captured_at: row.capturedAt,
    });
    if (attachError) {
      if (!existed) await client.storage.from('bob-uploads').remove([row.storagePath]);
      throw attachError;
    }
    if (typeof evidenceId !== 'string') throw new Error('Evidence attachment did not return an evidence identifier');
    attached += 1;
  }

  const { data: verified, error: verifyError } = await client
    .from('evidence_items')
    .select('id,sha256_hash,captured_at,metadata')
    .in('sha256_hash', prepared.map((row) => row.sha256))
    .eq('metadata->>provenance', 'external');
  if (verifyError) throw verifyError;
  const expected = new Set(prepared.map((row) => `${row.observation_id}:${row.sha256}`));
  const verifiedKeys = new Set((verified ?? []).map((row) => `${row.metadata?.record_id}:${row.sha256_hash}`));
  const missing = [...expected].filter((key) => !verifiedKeys.has(key));
  if (missing.length > 0) throw new Error(`${missing.length} evidence records failed post-import verification`);

  console.log(JSON.stringify({
    mode: 'apply',
    selected: prepared.length,
    uploaded,
    reused,
    attached,
    verified: expected.size,
  }));
  await client.auth.signOut();
}

await main();
