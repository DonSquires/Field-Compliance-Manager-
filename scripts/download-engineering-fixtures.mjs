/** Download engineering fixture files back from the private `engineering-fixtures` Supabase Storage bucket.
 * Run: node scripts/download-engineering-fixtures.mjs <remotePrefix> <localDir>
 * Example: node scripts/download-engineering-fixtures.mjs cctv-samples/tapo-2026-09 /tmp/tapo-sample
 */
import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const [, , remotePrefixArg, localDirArg] = process.argv;
if (!remotePrefixArg || !localDirArg) throw new Error('usage: node download-engineering-fixtures.mjs <remotePrefix> <localDir>');
const remotePrefix = remotePrefixArg.replace(/^\/+|\/+$/g, '');
const localDir = path.resolve(localDirArg);
const BUCKET = 'engineering-fixtures';
const headers = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };

async function listRecursive(prefix, out = []) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!response.ok) throw new Error(`list failed for ${prefix}: HTTP ${response.status} ${await response.text()}`);
  const entries = await response.json();
  for (const entry of entries) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) await listRecursive(full, out);
    else out.push(full);
  }
  return out;
}

async function downloadOne(remotePath) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(remotePath)}`, { headers: { Authorization: headers.Authorization, apikey: headers.apikey } });
  if (!response.ok) throw new Error(`download failed for ${remotePath}: HTTP ${response.status}`);
  const relative = remotePath.slice(remotePrefix.length).replace(/^\/+/, '');
  const destination = path.join(localDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

async function main() {
  const files = await listRecursive(remotePrefix);
  console.log(`downloading ${files.length} files from ${BUCKET}/${remotePrefix} to ${localDir}`);
  for (const remotePath of files) {
    const destination = await downloadOne(remotePath);
    console.log(`  ${destination}`);
  }
  console.log('done');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
