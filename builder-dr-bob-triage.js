'use strict';

// Dr Bob's production findings enter Bob's governed repair intake (owner ruling 2026-10-27: Bob tests
// and heals his own build without a person relaying the evidence). A failed live walk files each
// distinct HTTP error response through the same bob-triage-report path a signed-in person's friction
// uses, as the dedicated test identity that observed it: the triage classifier, stop-lines, repair-risk
// governance, and idempotency all apply unchanged. Only a routine packet enters unattended Builder
// intake; significant and protected findings wait for the Grandmaster.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[a-f0-9]{40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_FILE = 'human-test-report.json';
const MAX_REPORT_DIRS = 100;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_PER_REPORT = 500;
const DEFAULT_MAX_FINDINGS = 10;
const SAFE_PAGE_PARAMS = ['area', 'tab', 'view', 'section', 'mode'];
const OPEN_DISPOSITIONS = ['open', 'reviewing'];

function clip(value, maximum = 300) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, maximum);
}

// Record ids, emails, long numbers, and opaque tokens never leave the control plane.
function maskSegment(segment) {
  const value = String(segment);
  if (UUID_RE.test(value)) return ':id';
  if (value.includes('@')) return ':email';
  if (/^\d+$/.test(value)) return ':n';
  if (value.length >= 24 && /\d/.test(value) && /[A-Za-z]/.test(value)) return ':token';
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\d{6,}/g, ':n')
    .slice(0, 80);
}

function maskPath(pathname) {
  return String(pathname || '/').split('/').map((segment) => (segment ? maskSegment(segment) : segment)).join('/').slice(0, 200) || '/';
}

// The route a person was on: path plus navigation-only parameters; every other query value is dropped.
function safePageRoute(pageUrl) {
  let url;
  try { url = new URL(String(pageUrl || '')); } catch { return 'unknown'; }
  const kept = new URLSearchParams();
  for (const key of SAFE_PAGE_PARAMS) {
    const value = url.searchParams.get(key);
    if (value && /^[A-Za-z0-9_-]{1,60}$/.test(value)) kept.set(key, maskSegment(value));
  }
  const query = kept.toString();
  return `${maskPath(url.pathname)}${query ? `?${query}` : ''}`;
}

function describeEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '')); } catch { return null; }
  const pathname = url.pathname;
  const rpc = pathname.match(/^\/rest\/v1\/rpc\/([A-Za-z0-9_]{1,120})\/?$/);
  if (rpc) return { kind: 'rpc', label: `rpc/${rpc[1]}` };
  const edgeFunction = pathname.match(/^\/functions\/v1\/([A-Za-z0-9_-]{1,120})(?:\/|$)/);
  if (edgeFunction) return { kind: 'edge_function', label: `functions/${edgeFunction[1]}` };
  const table = pathname.match(/^\/rest\/v1\/([A-Za-z0-9_]{1,120})\/?$/);
  if (table) return { kind: 'table', label: `rest/${table[1]}` };
  // Storage object paths can name files; keep the operation only.
  const storage = pathname.match(/^\/storage\/v1\/([A-Za-z0-9_-]{1,40})/);
  if (storage) return { kind: 'storage', label: `storage/${storage[1]}` };
  const auth = pathname.match(/^\/auth\/v1\/([A-Za-z0-9_-]{1,40})/);
  if (auth) return { kind: 'auth', label: `auth/${auth[1]}` };
  return { kind: 'http', label: `${url.hostname}${maskPath(pathname)}`.slice(0, 200) };
}

function findingFingerprint({ status, method, endpoint, page }) {
  return crypto.createHash('sha256').update(`${status}|${method}|${endpoint}|${page}`).digest('hex').slice(0, 16);
}

function normaliseEvent(event, report) {
  const status = Number(event?.status);
  if (!Number.isInteger(status) || status < 400 || status > 599) return null;
  const method = String(event?.method || '').toUpperCase();
  if (!/^[A-Z]{3,7}$/.test(method)) return null;
  const endpoint = describeEndpoint(event?.endpoint);
  if (!endpoint) return null;
  const page = safePageRoute(event?.page);
  const viewport = /^[a-z0-9-]{1,40}$/.test(String(report?.project || '')) ? report.project : 'unknown';
  return {
    fingerprint: findingFingerprint({ status, method, endpoint: endpoint.label, page }),
    status,
    method,
    endpoint: endpoint.label,
    endpoint_kind: endpoint.kind,
    page,
    walk: clip(report?.title || 'Dr Bob live walk', 160),
    viewports: [viewport],
    occurrences: 1,
  };
}

// Reads only <resultsDir>/<test>/human-test-report.json: regular files, bounded in count and size.
function collectLiveHttpFindings({ resultsDir, maxFindings = DEFAULT_MAX_FINDINGS }) {
  const collected = { findings: [], total: 0, unique: 0, reports: 0, unreadable: 0, truncated: false };
  let entries;
  try { entries = fs.readdirSync(resultsDir, { withFileTypes: true }); } catch { return collected; }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(0, MAX_REPORT_DIRS);
  const byFingerprint = new Map();
  for (const directory of directories) {
    const file = path.join(resultsDir, directory, REPORT_FILE);
    let report;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
        collected.unreadable += 1;
        continue;
      }
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') collected.unreadable += 1;
      continue;
    }
    collected.reports += 1;
    const events = Array.isArray(report?.httpErrorEvents) ? report.httpErrorEvents.slice(0, MAX_EVENTS_PER_REPORT) : [];
    for (const event of events) {
      const finding = normaliseEvent(event, report);
      if (!finding) continue;
      collected.total += 1;
      const existing = byFingerprint.get(finding.fingerprint);
      if (!existing) {
        byFingerprint.set(finding.fingerprint, finding);
        continue;
      }
      existing.occurrences += 1;
      if (!existing.viewports.includes(finding.viewports[0])) existing.viewports.push(finding.viewports[0]);
    }
  }
  const ordered = [...byFingerprint.values()].sort((left, right) => (
    Number(right.status >= 500) - Number(left.status >= 500)
    || right.occurrences - left.occurrences
    || left.fingerprint.localeCompare(right.fingerprint)
  ));
  collected.unique = ordered.length;
  collected.truncated = ordered.length > maxFindings;
  collected.findings = ordered.slice(0, maxFindings);
  return collected;
}

// A schema-v1 friction envelope. Fixed wording stays free of the repair-risk terms so the classifier
// decides from the evidence (page, endpoint, walk), not from Dr Bob's own phrasing.
function buildTriageEnvelope(finding, { sha }) {
  const short = String(sha).slice(0, 12);
  return {
    schema_version: '1',
    before: {
      page: finding.page,
      targetRoute: finding.page,
      module: 'dr_bob_production',
      workspace: 'production',
      viewport: finding.viewports.join(',').slice(0, 160),
      view_title: finding.walk,
      recent_actions: [`dr_bob_live_walk:${short}`, `walk:${finding.walk}`.slice(0, 200), `occurrences:${finding.occurrences}`],
    },
    during: {
      error: {
        kind: 'http_error',
        name: `HTTP ${finding.status}`,
        message: `Dr Bob's read-only production walk of ${short} saw ${finding.method} ${finding.endpoint} return HTTP ${finding.status} on ${finding.page}.`,
      },
      failed_request: { fn: finding.endpoint, route: finding.page, status: finding.status },
    },
    expected: {
      user_intent: `Open ${finding.page} and read it the way a person would.`,
      expected_outcome: `${finding.page} renders without HTTP errors: ${finding.method} ${finding.endpoint} succeeds, or the page shows an explicit handled state instead of failing.`,
    },
  };
}

function packetKey(fingerprint, sha) {
  return `dr-bob:${fingerprint}:${String(sha).slice(0, 12).toLowerCase()}`;
}

async function postJson(fetchImpl, url, { headers, body, timeoutMs = 20_000 }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: response.ok, status: response.status, json };
}

// Files each finding once per open defect. The observer session is the dedicated test identity's own,
// opened for this intake only and signed out afterwards; no token or password is returned or logged.
async function fileDrBobFindings({
  findings,
  sha,
  supabaseUrl,
  anonKey,
  email,
  password,
  findOpenPacket,
  fetchImpl = globalThis.fetch,
}) {
  const outcome = { status: 'none', filed: [], skipped: [], errors: [] };
  if (!Array.isArray(findings) || !findings.length) return outcome;
  if (!SHA_RE.test(String(sha || ''))) return { ...outcome, status: 'failed', errors: [{ error: 'production SHA is missing' }] };
  if (!supabaseUrl || !anonKey || !email || !password || typeof fetchImpl !== 'function' || typeof findOpenPacket !== 'function') {
    return { ...outcome, status: 'unconfigured', errors: [{ error: 'Dr Bob triage intake is not configured' }] };
  }
  const base = String(supabaseUrl).replace(/\/+$/, '');
  let session;
  try {
    session = await postJson(fetchImpl, `${base}/auth/v1/token?grant_type=password`, { headers: { apikey: anonKey }, body: { email, password } });
  } catch (error) {
    return { ...outcome, status: 'failed', errors: [{ error: clip(`test identity sign-in failed: ${error instanceof Error ? error.message : error}`) }] };
  }
  const accessToken = session.json?.access_token;
  const observerId = session.json?.user?.id;
  if (!session.ok || typeof accessToken !== 'string' || !UUID_RE.test(String(observerId || ''))) {
    return { ...outcome, status: 'failed', errors: [{ error: `test identity sign-in returned HTTP ${session.status}` }] };
  }
  const headers = { apikey: anonKey, Authorization: `Bearer ${accessToken}` };
  try {
    for (const finding of findings) {
      const key = packetKey(finding.fingerprint, sha);
      try {
        const open = await findOpenPacket({ observerId, fingerprint: finding.fingerprint });
        if (open?.id) {
          outcome.skipped.push({ fingerprint: finding.fingerprint, reason: 'open_packet_exists', packet_id: open.id });
          continue;
        }
        const filed = await postJson(fetchImpl, `${base}/functions/v1/bob-triage-report`, {
          headers,
          body: { client_packet_key: key, envelope: buildTriageEnvelope(finding, { sha }) },
        });
        if (!filed.ok || !filed.json?.packet_id) {
          outcome.errors.push({ fingerprint: finding.fingerprint, error: clip(filed.json?.error || `triage returned HTTP ${filed.status}`, 200) });
          continue;
        }
        outcome.filed.push({
          fingerprint: finding.fingerprint,
          packet_id: filed.json.packet_id,
          status: finding.status,
          endpoint: finding.endpoint,
          page: finding.page,
          triage: filed.json.triage ?? null,
          route: filed.json.route ?? null,
          repair_risk: filed.json.repair_risk ?? null,
          automation_status: filed.json.automation_status ?? null,
        });
      } catch (error) {
        outcome.errors.push({ fingerprint: finding.fingerprint, error: clip(error instanceof Error ? error.message : error, 200) });
      }
    }
  } finally {
    await postJson(fetchImpl, `${base}/auth/v1/logout?scope=local`, { headers }).catch(() => null);
  }
  outcome.status = outcome.errors.length ? (outcome.filed.length || outcome.skipped.length ? 'partial' : 'failed') : 'filed';
  return outcome;
}

// The open-packet guard: one open Dr Bob packet per defect, whichever SHA first observed it.
function openDrBobPacketFinder(supabase) {
  return async ({ observerId, fingerprint }) => {
    if (!/^[a-f0-9]{16}$/.test(String(fingerprint || ''))) throw new Error('invalid finding fingerprint');
    const { data, error } = await supabase
      .from('bob_friction_packets')
      .select('id')
      .eq('user_id', observerId)
      .like('client_packet_key', `dr-bob:${fingerprint}:%`)
      .in('disposition', OPEN_DISPOSITIONS)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`open packet lookup failed: ${clip(error.message, 160)}`);
    return data ?? null;
  };
}

module.exports = {
  buildTriageEnvelope,
  collectLiveHttpFindings,
  describeEndpoint,
  fileDrBobFindings,
  openDrBobPacketFinder,
  packetKey,
  safePageRoute,
  DEFAULT_MAX_FINDINGS,
};
