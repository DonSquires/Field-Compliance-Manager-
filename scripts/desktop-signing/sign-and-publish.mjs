#!/usr/bin/env node
// Sign and publish an FCM Desktop V2 installer on the protected side. GitHub builds; this signs.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/desktop-signing/sign-and-publish.mjs --tag sd-card-bridge-v2-v0.1.9
//   node scripts/desktop-signing/sign-and-publish.mjs --tag sd-card-bridge-v2-v0.1.9 --input ./FCM-Desktop-V2-Setup.exe   (skip the gh download)
//   ... --no-release-upload   (leave the GitHub release asset unsigned; publish signed only to storage)
//
// Steps: gh release download (private repo, GITHUB_TOKEN) -> desktop_signing_material() from Vault (service role; every
// read is audited) -> osslsigncode sign (SHA-256, RFC 3161 timestamp) -> osslsigncode verify -> public certificate
// extracted from the PFX -> SHA256SUMS + manifest.json -> upsert to desktop-releases/v2/<version>/ -> optionally
// replace the GitHub release asset. The PFX exists on disk only inside a 0700 temp dir for the length of the run and
// is wiped in `finally`. Nothing secret is printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const TAG = opt('tag');
const INPUT = opt('input');
const REPO = opt('repo', 'DonSquires/Field-Compliance-Manager-');
const BUCKET = opt('bucket', 'desktop-releases');
const TIMESTAMP_URL = opt('timestamp', 'http://timestamp.digicert.com');
const FILE_NAME = 'FCM-Desktop-V2-Setup.exe';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TAG) fail('--tag sd-card-bridge-v2-v<version> is required');
if (!SUPABASE_URL || !SERVICE_KEY) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (protected-side run only)');
const version = TAG.replace(/^sd-card-bridge-v2-v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`tag ${TAG} does not carry a version`);
for (const tool of ['osslsigncode', 'openssl']) {
  if (spawnSync('which', [tool]).status !== 0) fail(`${tool} is not installed (scripts/desktop-signing/install-osslsigncode.sh)`);
}
// The signer is a self-signed end-entity certificate (CA:FALSE, keyUsage digitalSignature). OpenSSL 1.1.1 refuses
// to treat such a certificate as its own trust anchor ("unable to get local issuer certificate"); OpenSSL 3 accepts
// it, so verification only means anything when osslsigncode is linked against OpenSSL 3 and knows -CAfile (>= 2.1).
{
  const banner = spawnSync('osslsigncode', ['--version'], { encoding: 'utf8' });
  const text = `${banner.stdout || ''}${banner.stderr || ''}`;
  const tool = /osslsigncode\s+(\d+)\.(\d+)/.exec(text);
  const ssl = /OpenSSL\s+(\d+)\./.exec(text);
  if (!tool || Number(tool[1]) < 2 || (Number(tool[1]) === 2 && Number(tool[2]) < 1)) fail(`osslsigncode 2.1 or newer is required (found: ${text.split('\n')[0] || 'unknown'}); run scripts/desktop-signing/install-osslsigncode.sh`);
  if (!ssl || Number(ssl[1]) < 3) fail(`osslsigncode must be linked against OpenSSL 3 to verify the self-signed signer (found: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}); run scripts/desktop-signing/install-osslsigncode.sh`);
}

function fail(message) { console.error(`sign-and-publish: ${message}`); process.exit(1); }
function log(event, detail = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail })); }
function run(cmd, cmdArgs, options = {}) {
  const { redact = [], ...spawnOptions } = options;
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...spawnOptions });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 800);
    throw new Error(`${cmd} ${cmdArgs.filter((a) => !redact.includes(a)).join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}
async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function upload(path, bytes, contentType) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'x-upsert': 'true', 'Content-Type': contentType },
    body: bytes,
  });
  if (!response.ok) throw new Error(`upload ${path} -> ${response.status} ${(await response.text()).slice(0, 300)}`);
}

const work = mkdtempSync(join(tmpdir(), 'fcm-sign-'));
chmodSync(work, 0o700);
const pfxPath = join(work, 'signing.pfx');
try {
  // 1. The unsigned installer.
  let unsignedPath = INPUT;
  if (!unsignedPath) {
    run('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', FILE_NAME, '--dir', work, '--clobber']);
    unsignedPath = join(work, FILE_NAME);
  }
  if (!existsSync(unsignedPath)) fail(`installer not found at ${unsignedPath}`);
  const unsignedSha = createHash('sha256').update(readFileSync(unsignedPath)).digest('hex');
  log('installer_ready', { tag: TAG, version, bytes: statSync(unsignedPath).size, unsigned_sha256: unsignedSha });

  // 2. Signing material from Vault (audited read).
  const material = await rpc('desktop_signing_material');
  writeFileSync(pfxPath, Buffer.from(material.pfx_base64, 'base64'), { mode: 0o600 });
  const password = material.pfx_password;
  material.pfx_base64 = null; material.pfx_password = null;

  // 3. Public certificate out of the PFX first: it is the fleet trust object and the anchor the verifier checks against.
  const certPem = run('openssl', ['pkcs12', '-in', pfxPath, '-clcerts', '-nokeys', '-passin', `pass:${password}`], { redact: [`pass:${password}`] });
  const certPemPath = join(work, 'signer.pem');
  writeFileSync(certPemPath, certPem, { mode: 0o600 });
  const cerPath = join(work, 'signer.cer');
  run('openssl', ['x509', '-in', certPemPath, '-outform', 'DER', '-out', cerPath]);
  const cerDer = readFileSync(cerPath);
  const subject = run('openssl', ['x509', '-noout', '-subject'], { input: certPem }).trim().replace(/^subject=\s*/, '');
  const thumbprint = run('openssl', ['x509', '-noout', '-fingerprint', '-sha1'], { input: certPem }).trim().split('=').pop().replace(/:/g, '');
  const notAfter = run('openssl', ['x509', '-noout', '-enddate'], { input: certPem }).trim().replace(/^notAfter=/, '');

  // 4. Sign + timestamp, then verify with the signer certificate as the trust anchor; the PFX is wiped straight after.
  const signedPath = join(work, 'signed.exe');
  run('osslsigncode', ['sign', '-pkcs12', pfxPath, '-pass', password, '-h', 'sha256', '-ts', TIMESTAMP_URL,
    '-n', 'FCM Desktop V2', '-i', 'https://www.fcmanager.co.nz', '-in', unsignedPath, '-out', signedPath], { redact: [password] });
  rmSync(pfxPath, { force: true });
  const verifyReport = spawnSync('osslsigncode', ['verify', '-in', signedPath, '-CAfile', certPemPath], { encoding: 'utf8' });
  const report = `${verifyReport.stdout}\n${verifyReport.stderr}`;
  if (verifyReport.status !== 0 || !/Signature verification: ok/i.test(report)) {
    // The reason sits at the end of osslsigncode's report (after the certificate dump), so keep the tail.
    throw new Error(`signature verification did not pass (osslsigncode exit ${verifyReport.status}): …${report.slice(-1600)}`);
  }
  const timestamped = /Timestamp Server Signature verification: ok/i.test(report);
  log('signed', { signer: subject, thumbprint, timestamped });

  // 5. Integrity manifest.
  const signedBytes = readFileSync(signedPath);
  const sha256 = createHash('sha256').update(signedBytes).digest('hex');
  const gitSha = spawnSync('git', ['rev-parse', TAG], { encoding: 'utf8' }).stdout?.trim() || null;
  const manifest = {
    product: 'FCM Desktop V2', version, file: FILE_NAME, sha256, size_bytes: signedBytes.length, git_sha: gitSha,
    built_from_tag: TAG, unsigned_sha256: unsignedSha, signed: true, signer: subject, signer_thumbprint: thumbprint,
    signer_valid_until: notAfter, timestamped, signed_at: new Date().toISOString(), signed_by: 'scripts/desktop-signing/sign-and-publish.mjs',
    verify: `certutil -hashfile ${FILE_NAME} SHA256`, trust: 'Import FCM-Desktop-Signing.cer into Trusted Publishers (and Trusted Root) on managed machines.',
  };
  const sums = `${sha256}  ${FILE_NAME}\n`;

  // 6. Publish.
  const prefix = `v2/${version}`;
  await upload(`${prefix}/${FILE_NAME}`, signedBytes, 'application/vnd.microsoft.portable-executable');
  await upload(`${prefix}/SHA256SUMS`, Buffer.from(sums), 'text/plain');
  await upload(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  await upload(`${prefix}/FCM-Desktop-Signing.cer`, cerDer, 'application/pkix-cert');
  await upload('v2/FCM-Desktop-Signing.cer', cerDer, 'application/pkix-cert');
  log('published', { bucket: BUCKET, prefix, sha256, signer: subject, thumbprint, valid_until: notAfter, timestamped });

  if (!flag('no-release-upload')) {
    const release = join(work, FILE_NAME);
    writeFileSync(release, signedBytes);
    writeFileSync(join(work, 'SHA256SUMS'), sums);
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(work, 'FCM-Desktop-Signing.cer'), cerDer);
    run('gh', ['release', 'upload', TAG, release, join(work, 'SHA256SUMS'), join(work, 'manifest.json'), join(work, 'FCM-Desktop-Signing.cer'), '--repo', REPO, '--clobber']);
    log('release_assets_replaced', { tag: TAG });
  }
  console.log(`\nSigned ${FILE_NAME} v${version} as ${subject}\nSHA-256 ${sha256}\nPublished to ${BUCKET}/${prefix}/`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
