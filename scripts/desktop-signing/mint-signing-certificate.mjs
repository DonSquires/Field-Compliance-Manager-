#!/usr/bin/env node
// Mint the organisation's code-signing certificate on the protected side and store it straight into Supabase Vault.
// The private key is generated here, lives on disk only inside a 0700 temp dir for the length of the run, is stored
// through set_desktop_signing_material (service role, audited), read back and digest-compared, then shredded.
// Nothing secret is printed. The public certificate is written out for fleet trust.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/desktop-signing/mint-signing-certificate.mjs \
//     [--subject "/CN=Iron Eagle Security Ltd/O=Iron Eagle Security Ltd/C=NZ"] [--years 3] [--out-cer desktop-signing-intake/FCM-Desktop-Signing.cer]
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const SUBJECT = opt('subject', '/CN=Iron Eagle Security Ltd/O=Iron Eagle Security Ltd/C=NZ');
const YEARS = Number(opt('years', '3'));
const OUT_CER = resolve(opt('out-cer', 'desktop-signing-intake/FCM-Desktop-Signing.cer'));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function fail(message) { console.error(`mint-signing-certificate: ${message}`); process.exit(1); }
if (!SUPABASE_URL || !SERVICE_KEY) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
if (!Number.isInteger(YEARS) || YEARS < 1 || YEARS > 5) fail('--years must be 1..5');
function run(cmd, cmdArgs, options = {}) {
  const { redact = [], ...spawnOptions } = options;
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...spawnOptions });
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.filter((a) => !redact.includes(a)).join(' ')} failed: ${String(result.stderr || result.stdout || '').trim().slice(0, 600)}`);
  return result.stdout;
}
function shred(path) {
  try { const size = statSync(path).size; const fd = openSync(path, 'r+'); writeSync(fd, randomBytes(size), 0, size, 0); closeSync(fd); } catch { /* unlink regardless */ }
  try { unlinkSync(path); } catch { /* already gone */ }
}
async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const work = mkdtempSync(join(tmpdir(), 'fcm-mint-'));
const keyPath = join(work, 'key.pem');
const certPath = join(work, 'cert.pem');
const pfxPath = join(work, 'signing.pfx');
try {
  // Same shape New-SelfSignedCertificate -Type CodeSigningCert produces: RSA-3072, SHA-256, Code Signing EKU, digitalSignature, not a CA.
  run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', String(YEARS * 365), '-subj', SUBJECT,
    '-addext', 'extendedKeyUsage=codeSigning', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-keyout', keyPath, '-out', certPath]);
  const password = randomBytes(32).toString('base64url');
  // PBES2/AES-256 + SHA-256 MAC: readable by osslsigncode/OpenSSL 3 and importable on Windows 10+.
  run('openssl', ['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-out', pfxPath, '-passout', `pass:${password}`,
    '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256', '-name', 'FCM Desktop code signing'], { redact: [`pass:${password}`] });
  run('openssl', ['pkcs12', '-in', pfxPath, '-noout', '-passin', `pass:${password}`], { redact: [`pass:${password}`] });

  const certPem = readFileSync(certPath, 'utf8');
  const x509 = (flags) => run('openssl', ['x509', '-noout', ...flags], { input: certPem }).trim();
  const subject = x509(['-subject']).replace(/^subject=\s*/, '');
  const thumbprint = x509(['-fingerprint', '-sha1']).split('=').pop().replace(/:/g, '').toUpperCase();
  const notAfter = x509(['-enddate']).replace(/^notAfter=/, '');
  const pfxBytes = readFileSync(pfxPath);

  const stored = await rpc('set_desktop_signing_material', { p_pfx_base64: pfxBytes.toString('base64'), p_password: password, p_note: `Minted ${new Date().toISOString().slice(0, 10)} on the protected side (${thumbprint})` });
  const back = await rpc('desktop_signing_material');
  const same = createHash('sha256').update(Buffer.from(String(back.pfx_base64 || ''), 'base64')).digest('hex') === createHash('sha256').update(pfxBytes).digest('hex') && back.pfx_password === password;
  if (!same) fail('read-back from Vault does not match what was stored');

  mkdirSync(dirname(OUT_CER), { recursive: true });
  run('openssl', ['x509', '-in', certPath, '-outform', 'DER', '-out', OUT_CER]);
  console.log(JSON.stringify({ stored: Boolean(stored?.stored), vault_names: stored?.names, signer: subject, thumbprint, valid_until: notAfter, key: 'RSA-3072 / SHA-256', public_certificate: OUT_CER, read_back: 'matches' }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  for (const path of [keyPath, pfxPath, certPath]) shred(path);
  rmSync(work, { recursive: true, force: true });
}
