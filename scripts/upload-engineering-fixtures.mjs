/** Upload a local directory tree into the private `engineering-fixtures` Supabase Storage bucket, preserving
 * relative paths under a prefix, then verify every object's remote size matches the local file size.
 * Run: node scripts/upload-engineering-fixtures.mjs <localDir> <remotePrefix>
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const [, , localDirArg, remotePrefixArg] = process.argv;
if (!localDirArg || !remotePrefixArg) throw new Error('usage: node upload-engineering-fixtures.mjs <localDir> <remotePrefix>');
const localDir = path.resolve(localDirArg);
const remotePrefix = remotePrefixArg.replace(/^\/+|\/+$/g, '');
const BUCKET = 'engineering-fixtures';

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function uploadOne(localPath) {
  const relative = path.relative(localDir, localPath).split(path.sep).join('/');
  const remotePath = `${remotePrefix}/${relative}`;
  const size = fs.statSync(localPath).size;
  const body = fs.readFileSync(localPath);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(remotePath)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  });
  if (!response.ok) throw new Error(`upload failed for ${remotePath}: HTTP ${response.status} ${await response.text()}`);
  return { relative, remotePath, size, sha256: sha256(localPath) };
}

async function main() {
  const files = walk(localDir).sort();
  console.log(`uploading ${files.length} files from ${localDir} to ${BUCKET}/${remotePrefix}`);
  const manifest = [];
  let uploadedBytes = 0;
  for (const file of files) {
    const start = Date.now();
    const result = await uploadOne(file);
    uploadedBytes += result.size;
    manifest.push(result);
    console.log(`  ${result.remotePath} (${(result.size / 1e6).toFixed(1)} MB) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  console.log(`uploaded ${(uploadedBytes / 1e6).toFixed(1)} MB total`);

  // Verify: list every object under the prefix (recursively) and check reported size against the manifest.
  const remoteSizes = new Map();
  async function listRecursive(prefix) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!response.ok) throw new Error(`list failed for ${prefix}: HTTP ${response.status} ${await response.text()}`);
    const entries = await response.json();
    for (const entry of entries) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) await listRecursive(full); // a folder placeholder has no id
      else remoteSizes.set(full, entry.metadata?.size ?? null);
    }
  }
  await listRecursive(remotePrefix);

  let mismatches = 0;
  for (const item of manifest) {
    const remoteSize = remoteSizes.get(item.remotePath);
    if (remoteSize !== item.size) {
      mismatches += 1;
      console.error(`SIZE MISMATCH: ${item.remotePath} local=${item.size} remote=${remoteSize}`);
    }
  }
  if (mismatches > 0) throw new Error(`${mismatches} object(s) failed size verification; local files were not deleted`);
  console.log(`verified ${manifest.length}/${manifest.length} objects by size`);

  const manifestPath = path.join(path.dirname(localDir), `${path.basename(localDir).replace(/\s+/g, '-').toLowerCase()}-upload-manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ bucket: BUCKET, remotePrefix, uploadedAt: new Date().toISOString(), files: manifest }, null, 1));
  console.log(`manifest written to ${manifestPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
