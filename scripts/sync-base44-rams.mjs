// Read-only Base44 RAMS (OFO) -> FCM sync: hunter kill/nil returns and permit holders.
//
// Base44 stays the system of record. This script only issues GET requests to Base44, using a
// dedicated read-only integration token, and hands normalised rows to the server-only FCM RPCs
// ingest_base44_rams_kill_returns and ingest_base44_rams_permits (service role). It fails closed
// when the token is missing and never prints tokens or personal details; reports carry counts only.
//
// Usage:
//   node scripts/sync-base44-rams.mjs --dry-run [--report <file>]
//   node scripts/sync-base44-rams.mjs --apply   [--report <file>]
//
// Token: BASE44_RAMS_READ_TOKEN, or the file at BASE44_RAMS_TOKEN_FILE
// (default %LOCALAPPDATA%\FCM\base44\rams-read-token). --apply also needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE44_APP_ID = '68b0e762a4fe8d4f9ba543ca';
export const PROVIDER_ORGANIZATION_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
// Base44 company -> FCM client organisation. Companies not listed here are held, never guessed.
export const COMPANY_CLIENTS = Object.freeze({
  '6927aa3bc01e948e087c9878': 'c48c1aaf-236b-417c-bbce-938c151662d6', // OneFortyOne Limited -> OneFortyOne New Zealand
  '6927aa3bc01e948e087c9877': '74d7fcf1-106a-481f-a770-1589c8a0db6b', // Tasman Pine Forest Limited -> Tasman Pine Forests Limited
});
const PAGE_SIZE = 500;
const RPC_BATCH = 500;
const MAX_PAGES = 200;
// A complete listing that suddenly shrinks this much is treated as a source fault, not deletions.
export const MIN_LISTING_RATIO = 0.5;

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};
const isoDate = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
export function isoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  return /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}

export function readToken({ env = process.env, readFile = fs.readFileSync } = {}) {
  const fromEnv = text(env.BASE44_RAMS_READ_TOKEN, 4096);
  if (fromEnv) return { token: fromEnv, source: 'environment' };
  const file = env.BASE44_RAMS_TOKEN_FILE
    || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FCM', 'base44', 'rams-read-token');
  try {
    const token = text(readFile(file, 'utf8'), 4096);
    if (token) return { token, source: 'file' };
  } catch { /* fall through to the fail-closed error */ }
  throw new Error(`Base44 RAMS read token not configured: set BASE44_RAMS_READ_TOKEN or store it in ${file}. Sync aborted; nothing was read or written.`);
}

export function authHeaders(token, mode = 'bearer') {
  return mode === 'api_key' ? { api_key: token } : { Authorization: `Bearer ${token}` };
}

export async function fetchAll(entity, { fetchImpl = fetch, base, appId = BASE44_APP_ID, headers }) {
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/api/apps/${appId}/entities/${entity}?limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}&sort=created_date`;
    const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) {
      const error = new Error(`Base44 ${entity} read failed with HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`Base44 ${entity} returned an unexpected payload`);
    for (const row of batch) {
      if (row && typeof row.id === 'string' && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`Base44 ${entity} listing exceeded ${MAX_PAGES} pages; refusing a partial sync`);
}

export function buildIndexes({ users = [], bookings = [] }) {
  const people = new Map();
  for (const b of bookings) {
    if (typeof b.user_id === 'string' && !people.has(b.user_id)) {
      people.set(b.user_id, { name: text(b.user_full_name, 200), email: text(b.user_email, 254), phone: null, licence: null });
    }
  }
  for (const u of users) {
    if (typeof u.id !== 'string') continue;
    const prior = people.get(u.id) ?? {};
    people.set(u.id, {
      name: text(u.full_name, 200) ?? text(u.legal_name, 200) ?? prior.name ?? null,
      email: text(u.email, 254) ?? prior.email ?? null,
      phone: text(u.phone_number, 40),
      licence: u.firearms_license_status === 'active' ? true : u.firearms_license_status === 'inactive' ? false : null,
    });
  }
  const bookingPermits = new Map(bookings
    .filter((b) => typeof b.id === 'string' && text(b.permit_number, 64))
    .map((b) => [b.id, text(b.permit_number, 64)]));
  return { people, bookingPermits };
}

export function mapKillReturn(row, { bookingPermits = new Map(), companies = COMPANY_CLIENTS } = {}) {
  if (!row || row.is_sample) return { held: 'sample' };
  const client = companies[row.company_id];
  if (!client) return { held: 'unmapped_company' };
  const returnType = row.return_type === 'kill' || row.return_type === 'nil' ? row.return_type : null;
  const huntDate = isoDate(row.hunt_date);
  const area = text(row.hunting_area, 200);
  if (!returnType || !huntDate || !area || typeof row.id !== 'string') return { held: 'invalid' };
  const animals = returnType === 'kill' && Array.isArray(row.animals)
    ? row.animals
      .map((a) => ({ species: text(a?.species, 60), count: Number.isInteger(a?.count) ? a.count : Number.parseInt(a?.count, 10) }))
      .filter((a) => a.species && Number.isInteger(a.count) && a.count > 0)
    : [];
  return {
    row: {
      source_id: row.id,
      client_organization_id: client,
      booking_id: text(row.booking_id, 64),
      permit_number: (row.booking_id && bookingPermits.get(row.booking_id)) || null,
      hunting_area: area,
      hunt_date: huntDate,
      return_type: returnType,
      animals,
      comments: text(row.comments, 2000),
      hunter_name: text(row.user_name, 200),
      hunter_email: text(row.user_email, 254),
      source_created_at: isoTimestamp(row.created_date),
      source_updated_at: isoTimestamp(row.updated_date),
    },
  };
}

export function mapPermit(row, { people = new Map(), companies = COMPANY_CLIENTS } = {}) {
  if (!row || row.is_sample) return { held: 'sample' };
  const client = companies[row.company_id];
  if (!client) return { held: 'unmapped_company' };
  const person = people.get(row.user_id);
  const permitNumber = text(row.permit_number, 64);
  if (!permitNumber || typeof row.user_id !== 'string') return { held: 'invalid' };
  if (!person?.name) return { held: 'no_holder_name' };
  const status = ['active', 'expired', 'revoked', 'suspended'].includes(row.status) ? row.status : null;
  if (!status) return { held: 'invalid' };
  return {
    row: {
      permit_number: permitNumber,
      source_user_id: row.user_id,
      holder_name: person.name,
      contact_email: person.email,
      contact_phone: person.phone,
      firearm_licence_valid: person.licence,
      client_organization_id: client,
      status,
      expiry_date: isoDate(row.expiry_date),
      permit_type: text(row.permit_name, 120),
      applicant_type: text(row.application_type, 120),
      company_name: text(row.company_name, 200),
      activities: Array.isArray(row.permit_purpose) ? row.permit_purpose.map((p) => text(p, 80)).filter(Boolean) : [],
      firearms_permitted: typeof row.firearms_permitted === 'boolean' ? row.firearms_permitted : null,
      vehicles: Array.isArray(row.vehicles)
        ? row.vehicles.map((v) => ({ plate: text(v?.registration, 20), make: text(v?.make, 60), model: text(v?.model, 60), colour: text(v?.color, 40) }))
          .filter((v) => v.plate)
        : [],
    },
  };
}

export function partition(rows, mapper, context) {
  const mapped = [];
  const held = {};
  for (const source of rows) {
    const result = mapper(source, context);
    if (result.row) mapped.push(result.row);
    else held[result.held] = (held[result.held] ?? 0) + 1;
  }
  return { mapped, held };
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function rpc(fetchImpl, supabase, name, body) {
  const res = await fetchImpl(`${supabase.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: supabase.key, Authorization: `Bearer ${supabase.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.text();
  if (!res.ok) throw new Error(`FCM ${name} failed with HTTP ${res.status}: ${payload.slice(0, 300)}`);
  return JSON.parse(payload);
}

async function activeMirrorCount(fetchImpl, supabase) {
  const res = await fetchImpl(`${supabase.url}/rest/v1/hunter_kill_returns?select=id&organization_id=eq.${PROVIDER_ORGANIZATION_ID}&withdrawn_at=is.null&limit=1`, {
    headers: { apikey: supabase.key, Authorization: `Bearer ${supabase.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) throw new Error(`FCM mirror count failed with HTTP ${res.status}`);
  return Number.parseInt((res.headers.get('content-range') ?? '').split('/')[1] ?? '0', 10) || 0;
}

const sumInto = (total, part) => {
  for (const [key, value] of Object.entries(part)) if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  return total;
};

export async function runSync({ apply, env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const { token, source } = readToken({ env });
  const base = (env.BASE44_API_BASE || 'https://base44.app').replace(/\/+$/, '');
  const headers = authHeaders(token, env.BASE44_RAMS_AUTH === 'api_key' ? 'api_key' : 'bearer');
  const supabase = { url: (env.SUPABASE_URL || '').replace(/\/+$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY || '' };
  if (apply && (!supabase.url || !supabase.key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --apply');
  log(`Base44 RAMS sync (${apply ? 'apply' : 'dry run'}); token from ${source}`);

  const [killReturns, permits, bookings] = await Promise.all(
    ['KillReturn', 'Permit', 'Booking'].map((entity) => fetchAll(entity, { fetchImpl, base, headers })),
  );
  let users = [];
  let usersReadable = true;
  try {
    users = await fetchAll('User', { fetchImpl, base, headers });
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    usersReadable = false;
    log('Base44 User list is not readable with this token; holder names fall back to bookings.');
  }

  const indexes = buildIndexes({ users, bookings });
  const kills = partition(killReturns, mapKillReturn, indexes);
  const permitRows = partition(permits, mapPermit, indexes);
  const report = {
    at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    source: { killReturns: killReturns.length, permits: permits.length, bookings: bookings.length, users: users.length, usersReadable },
    killReturns: { mapped: kills.mapped.length, held: kills.held },
    permits: { mapped: permitRows.mapped.length, held: permitRows.held },
  };
  if (!apply) return report;

  const permitResult = {};
  for (const batch of chunks(permitRows.mapped, RPC_BATCH)) {
    sumInto(permitResult, await rpc(fetchImpl, supabase, 'ingest_base44_rams_permits', { p_provider_organization_id: PROVIDER_ORGANIZATION_ID, p_rows: batch }));
  }
  const killResult = {};
  for (const batch of chunks(kills.mapped, RPC_BATCH)) {
    sumInto(killResult, await rpc(fetchImpl, supabase, 'ingest_base44_rams_kill_returns', { p_provider_organization_id: PROVIDER_ORGANIZATION_ID, p_rows: batch, p_seen_source_ids: null }));
  }
  const seen = kills.mapped.map((row) => row.source_id);
  const active = await activeMirrorCount(fetchImpl, supabase);
  if (seen.length > 0 && seen.length >= active * MIN_LISTING_RATIO) {
    sumInto(killResult, await rpc(fetchImpl, supabase, 'ingest_base44_rams_kill_returns', { p_provider_organization_id: PROVIDER_ORGANIZATION_ID, p_rows: [], p_seen_source_ids: seen }));
    report.withdrawalChecked = true;
  } else {
    report.withdrawalChecked = false;
    log(`Withdrawal check skipped: Base44 listed ${seen.length} returns against ${active} active in FCM.`);
  }
  report.permits.result = permitResult;
  report.killReturns.result = killResult;
  return report;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const apply = process.argv.includes('--apply');
  if (!apply && !process.argv.includes('--dry-run')) {
    console.error('Usage: node scripts/sync-base44-rams.mjs --dry-run|--apply [--report <file>]');
    process.exit(2);
  }
  try {
    const report = await runSync({ apply });
    const out = argValue('--report');
    if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
