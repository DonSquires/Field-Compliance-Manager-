#!/usr/bin/env node
// Store the FCM Desktop code-signing material in Supabase Vault from a file dropped into the Codespace, then
// destroy the file. Nothing secret is printed; the values travel file -> this process -> service-role RPC only.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/desktop-signing/store-signing-material.mjs \
//     [--from desktop-signing-intake/fcm-desktop-signing.secrets.txt] [--expect-thumbprint <sha1>] [--keep]
//
// Accepts the secrets file written by New-FcmSigningCertificate.ps1 (either naming generation):
//   desktop_signing_pfx_base64=... / desktop_signing_pfx_password=...
//   FCM_DESKTOP_SIGNING_PFX_BASE64=... / FCM_DESKTOP_SIGNING_PFX_PASSWORD=...
// or a directory holding FCM-Desktop-Signing.pfx plus a `password.txt`.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const source = resolve(opt('from', 'desktop-signing-intake'));
const expectThumbprint = (opt('expect-thumbprint') || '').replace(/[^0-9a-f]/gi, '').toUpperCase() || null;

function fail(message) { console.error(`store-signing-material: ${message}`); process.exit(1); }
function shred(path) {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r+');
    writeSync(fd, randomBytes(size), 0, size, 0);
    closeSync(fd);
  } catch { /* fall through to unlink */ }
  unlinkSync(path);
}
async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// 1. Read the material from whatever was dropped in.
let pfxBase64 = null; let password = null; const consumed = [];
if (!existsSync(source)) fail(`nothing at ${source}. Drop fcm-desktop-signing.secrets.txt (or the .pfx + password.txt) into desktop-signing-intake/.`);
const files = statSync(source).isDirectory() ? readdirSync(source).map((name) => join(source, name)) : [source];
for (const file of files) {
  if (/\.secrets\.txt$/i.test(file) || /secrets/i.test(file) && file.endsWith('.txt')) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(desktop_signing_pfx_base64|FCM_DESKTOP_SIGNING_PFX_BASE64|desktop_signing_pfx_password|FCM_DESKTOP_SIGNING_PFX_PASSWORD)\s*=\s*(.*)$/);
      if (!match) continue;
      if (/base64/i.test(match[1])) pfxBase64 = match[2].trim(); else password = match[2];
    }
    consumed.push(file);
  } else if (/\.pfx$/i.test(file)) {
    pfxBase64 = readFileSync(file).toString('base64'); consumed.push(file);
  } else if (/^password(\.txt)?$/i.test(file.split('/').pop())) {
    password = readFileSync(file, 'utf8').replace(/\r?\n$/, ''); consumed.push(file);
  }
}
if (!pfxBase64 || !password) fail(`could not find both the PFX (base64 or .pfx) and its password in ${source}`);
pfxBase64 = pfxBase64.replace(/\s/g, '');
const pfxBytes = Buffer.from(pfxBase64, 'base64');
if (pfxBytes.length < 500) fail('the PFX decodes to something far too small to be a certificate + key');

// 2. Prove the PFX opens with that password and read the public facts before anything is stored.
const work = mkdtempSync(join(tmpdir(), 'fcm-store-'));
try {
  const pfxPath = join(work, 'in.pfx');
  writeFileSync(pfxPath, pfxBytes, { mode: 0o600 });
  let cert = spawnSync('openssl', ['pkcs12', '-in', pfxPath, '-clcerts', '-nokeys', '-passin', `pass:${password}`], { encoding: 'utf8' });
  if (cert.status !== 0) cert = spawnSync('openssl', ['pkcs12', '-legacy', '-in', pfxPath, '-clcerts', '-nokeys', '-passin', `pass:${password}`], { encoding: 'utf8' });
  if (cert.status !== 0) fail('the PFX did not open with the supplied password (wrong password, or an unsupported PFX encryption)');
  const x509 = (flags) => spawnSync('openssl', ['x509', '-noout', ...flags], { input: cert.stdout, encoding: 'utf8' }).stdout.trim();
  const subject = x509(['-subject']).replace(/^subject=\s*/, '');
  const thumbprint = x509(['-fingerprint', '-sha1']).split('=').pop().replace(/:/g, '').toUpperCase();
  const notAfter = x509(['-enddate']).replace(/^notAfter=/, '');
  const eku = x509(['-ext', 'extendedKeyUsage']);
  if (!/Code Signing/i.test(eku)) fail(`certificate lacks the Code Signing EKU (${eku.replace(/\s+/g, ' ')})`);
  if (expectThumbprint && thumbprint !== expectThumbprint) fail(`thumbprint ${thumbprint} does not match the expected ${expectThumbprint}`);

  // 3. Store, then read back and compare digests — never the values.
  let stored; let back;
  try {
    stored = await rpc('set_desktop_signing_material', { p_pfx_base64: pfxBase64, p_password: password, p_note: `Stored ${new Date().toISOString().slice(0, 10)} via store-signing-material (${thumbprint})` });
    back = await rpc('desktop_signing_material');
  } catch (error) {
    fail(`Vault write/read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const localDigest = createHash('sha256').update(pfxBytes).digest('hex');
  const remoteDigest = createHash('sha256').update(Buffer.from(String(back.pfx_base64 || ''), 'base64')).digest('hex');
  if (remoteDigest !== localDigest || back.pfx_password !== password) fail('read-back from Vault does not match what was sent');

  console.log(JSON.stringify({ stored: Boolean(stored?.stored), vault_names: stored?.names, signer: subject, thumbprint, valid_until: notAfter, pfx_bytes: pfxBytes.length, read_back: 'matches' }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 4. Destroy the intake files unless told to keep them.
if (!flag('keep')) {
  for (const file of consumed) shred(file);
  console.log(`Destroyed ${consumed.length} intake file(s). The PFX now exists only in Vault and in the owner's offline copy.`);
} else {
  console.log('Intake files kept (--keep). Remove them yourself.');
}
