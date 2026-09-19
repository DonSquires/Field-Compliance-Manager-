// Publish the FFmpeg decoder sidecar FCM Desktop V2 downloads on demand: one immutable LGPL build of
// ffmpeg.exe (BtbN/FFmpeg-Builds, static, LGPL configuration — no GPL components), its licence text, and a
// manifest with SHA-256s, to the public desktop-releases bucket under tools/ffmpeg/<version>/.
// The app pins the manifest's hashes in code, so a swapped binary is refused. Owner-authorised runs only.
//
//   node scripts/desktop-tools/publish-ffmpeg-sidecar.mjs <unpacked-build-dir> <version-label>
//   e.g. node scripts/desktop-tools/publish-ffmpeg-sidecar.mjs /tmp/ffm/ffmpeg-n8.1.2-54-gc573a95381-win64-lgpl-8.1 8.1.2-c573a95381
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [buildDir, version] = process.argv.slice(2);
if (!buildDir || !version) throw new Error('usage: publish-ffmpeg-sidecar.mjs <unpacked-build-dir> <version-label>');
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const BUCKET = 'desktop-releases';
const PREFIX = `tools/ffmpeg/${version}`;
const CHUNK = 6 * 1024 * 1024;

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function uploadResumable(file, objectName, contentType) {
  const size = fs.statSync(file).size;
  const metadata = Object.entries({ bucketName: BUCKET, objectName, contentType, cacheControl: '31536000' })
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',');
  const create = await fetch(`${SUPABASE_URL}/storage/v1/upload/resumable`, {
    method: 'POST', headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(size), 'Upload-Metadata': metadata, 'x-upsert': 'true' },
  });
  if (!create.ok) throw new Error(`tus create ${create.status}: ${(await create.text()).slice(0, 300)}`);
  const location = create.headers.get('location');
  const url = location.startsWith('http') ? location : `${SUPABASE_URL}/${location.replace(/^\//, '')}`;
  const fd = fs.openSync(file, 'r');
  let offset = 0;
  while (offset < size) {
    const length = Math.min(CHUNK, size - offset);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    const patch = await fetch(url, { method: 'PATCH', headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: buffer });
    if (!patch.ok) throw new Error(`tus patch ${patch.status} at ${offset}: ${(await patch.text()).slice(0, 300)}`);
    offset = Number(patch.headers.get('upload-offset') ?? offset + length);
    process.stdout.write(`\r  ${objectName}: ${Math.floor((offset / size) * 100)}%`);
  }
  fs.closeSync(fd);
  process.stdout.write('\n');
}

const ffmpeg = path.join(buildDir, 'bin', 'ffmpeg.exe');
const licence = path.join(buildDir, 'LICENSE.txt');
for (const file of [ffmpeg, licence]) if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
const manifest = {
  tool: 'ffmpeg', version, licence: 'LGPL (BtbN/FFmpeg-Builds win64-lgpl configuration; no GPL components)',
  source: 'https://github.com/BtbN/FFmpeg-Builds (FFmpeg source: https://ffmpeg.org)',
  build: path.basename(buildDir),
  files: {
    'ffmpeg.exe': { sha256: sha256(ffmpeg), bytes: fs.statSync(ffmpeg).size },
    'LICENSE.txt': { sha256: sha256(licence), bytes: fs.statSync(licence).size },
  },
  published_at: new Date().toISOString(),
};
console.log(JSON.stringify(manifest, null, 2));
await uploadResumable(ffmpeg, `${PREFIX}/ffmpeg.exe`, 'application/octet-stream');
await uploadResumable(licence, `${PREFIX}/LICENSE.txt`, 'text/plain');
const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${PREFIX}/manifest.json`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify(manifest, null, 2) });
if (!put.ok) throw new Error(`manifest upload ${put.status}: ${(await put.text()).slice(0, 300)}`);
for (const name of ['ffmpeg.exe', 'LICENSE.txt', 'manifest.json']) {
  const head = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PREFIX}/${name}`, { method: 'HEAD' });
  console.log(`  public ${name}: HTTP ${head.status}, ${head.headers.get('content-length')} bytes`);
}
console.log(`\nPin in the app: FFMPEG_SIDECAR_VERSION='${version}', FFMPEG_SIDECAR_SHA256='${manifest.files['ffmpeg.exe'].sha256}'`);
