import { createHash } from 'node:crypto';
import { aucklandInstant, normalizePlace } from '../../scripts/rm-photo-matcher.mjs';

// Owner ruling 2026-11-09: a structured camera photo ("YYMMDD HHMM[SS] [rego] …") that matches no
// logged entry is still a finding. It becomes a camera-capture row at its folder's place, written
// through the same governed patrol import as the workbooks, so the photo then attaches to it and
// reaches the client report. Folder labels, row vocabulary and limits are data in the source map;
// a folder that names no client, several clients or a hold term is held for a person.

const CODE = /^[A-Z0-9_-]{1,40}$/;
export const CAPTURE_FIELDS = ['job', 'patroller', 'date', 'time', 'location', 'source', 'subject', 'issue', 'comments', 'registration'];
export const MAX_CAPTURE_BATCHES = 200;

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const tokenOk = token => typeof token === 'string' && normalizePlace(token).length > 0 && token.length <= 40;

export function validatePhotoCaptures(config, sheetsByCode) {
  if (config === undefined) return;
  if (typeof config !== 'object' || typeof config.enabled !== 'boolean') throw new Error('photo_captures needs enabled true or false');
  for (const key of ['max_rows_per_batch', 'max_batches_per_run']) {
    const value = config[key];
    const ceiling = key === 'max_rows_per_batch' ? 5000 : MAX_CAPTURE_BATCHES;
    if (!Number.isInteger(value) || value < 0 || value > ceiling) throw new Error(`photo_captures.${key} must be 0-${ceiling}`);
  }
  if (typeof config.source_label_prefix !== 'string' || !/^[\p{L}\p{N} .-]{3,60}$/u.test(config.source_label_prefix)) {
    throw new Error('photo_captures.source_label_prefix must be a short label');
  }
  for (const field of CAPTURE_FIELDS) {
    if (typeof config.columns?.[field] !== 'string' || !config.columns[field].trim()) throw new Error(`photo_captures.columns.${field} is required`);
  }
  if (new Set(CAPTURE_FIELDS.map(field => config.columns[field].trim().toLowerCase())).size !== CAPTURE_FIELDS.length) {
    throw new Error('photo_captures.columns must be distinct');
  }
  for (const field of ['patroller', 'source', 'subject', 'issue']) {
    if (typeof config.values?.[field] !== 'string' || !config.values[field].trim()) throw new Error(`photo_captures.values.${field} is required`);
  }
  if (typeof config.values.comment_prefix !== 'string') throw new Error('photo_captures.values.comment_prefix is required');
  if (config.earliest_capture_date !== undefined && !validDate(config.earliest_capture_date)) {
    throw new Error('photo_captures.earliest_capture_date must be YYYY-MM-DD');
  }
  if (!Array.isArray(config.hold_label_tokens) || !config.hold_label_tokens.every(tokenOk)) {
    throw new Error('photo_captures.hold_label_tokens must be short words');
  }
  if (!Array.isArray(config.clients) || !config.clients.length) throw new Error('photo_captures.clients must name at least one client');
  const codes = new Set();
  const tokens = new Map();
  for (const client of config.clients) {
    if (!CODE.test(client.capture_code ?? '') || !CODE.test(client.profile_code ?? '')) throw new Error('photo_captures client codes are invalid');
    if (!sheetsByCode.has(client.profile_code)) throw new Error(`photo_captures profile ${client.profile_code} is not a mapped sheet`);
    if (sheetsByCode.has(client.capture_code) || codes.has(client.capture_code)) {
      throw new Error(`Client code ${client.capture_code} is mapped twice`);
    }
    codes.add(client.capture_code);
    if (!Array.isArray(client.label_tokens) || !client.label_tokens.length || !client.label_tokens.every(tokenOk)) {
      throw new Error(`photo_captures ${client.capture_code} needs label tokens`);
    }
    for (const token of client.label_tokens.map(normalizePlace)) {
      if (tokens.has(token) && tokens.get(token) !== client.capture_code) throw new Error(`Label token ${token} names two clients`);
      tokens.set(token, client.capture_code);
    }
  }
}

const hasToken = (label, token) => ` ${label} `.includes(` ${normalizePlace(token)} `);

// Folder segments are separated by a hyphen with a space on at least one side ("A - B - TPFL",
// "Spooners Gate -OFO"); a hyphen inside a word ("Kaka-Valley") is part of the name.
export function folderSegments(folder) {
  return String(folder ?? '').split(/\s+-\s*|\s*-\s+/).map(segment => segment.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Library folders are named "<Location> - <Area> - <Client>": the leading segment names the place
// and a later segment names the client (usually the last; sometimes the area, as in
// "Spooners - OFO - leads to Olivers and Berrymans").
export function resolveCaptureClient(relativePath, config) {
  const folders = String(relativePath ?? '').replaceAll('\\', '/').split('/');
  if (folders.length < 3) return { held: 'client_label_missing' };
  const segments = folderSegments(folders[1]);
  if (segments.length < 2) return { held: 'client_label_missing' };
  const labels = segments.slice(1).map(normalizePlace);
  if (labels.some(label => config.hold_label_tokens.some(token => hasToken(label, token)))) return { held: 'client_label_review' };
  const clients = config.clients.filter(client => labels.some(label => client.label_tokens.some(token => hasToken(label, token))));
  if (clients.length !== 1) return { held: clients.length ? 'client_label_multiple' : 'client_label_unmapped' };
  const location = segments[0];
  if (!normalizePlace(location)) return { held: 'capture_place_missing' };
  return { client: clients[0], location };
}

// What the officer typed after the date and time, e.g. "GPT23 white ute" or "stag".
export function photoDescription(relativePath) {
  const stem = String(relativePath ?? '').replaceAll('\\', '/').split('/').pop().replace(/\.[^.]*$/, '');
  return stem.replace(/(^|[^0-9])[0-9]{6}[ _-]+[0-9]{4}(?:[0-9]{2})?(?=[^0-9]|$)/, '$1 ')
    .replace(/\(\d+\)\s*$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s\-–,.;:]+|[\s\-–,.;:]+$/g, '');
}

function logNumber(code, placeKey, minuteKey) {
  const [date, time] = minuteKey.split(' ');
  const stamp = `${date.slice(2).replaceAll('-', '')}${time.replace(':', '')}`;
  return `CAM-${stamp}-${createHash('md5').update(`${code}|${placeKey}|${minuteKey}`).digest('hex').slice(0, 8)}`;
}

// One capture row per client, place and minute, carrying every plate seen in that minute, so each
// photo in the group then matches it uniquely (rego photos by plate, others by place).
// A minute that already holds a record for the client is held: the photo may belong to that entry.
export function buildCaptureGroups(photos, config, { minuteOrganizations = () => new Set() } = {}) {
  const groups = new Map();
  const holds = [];
  let ignored = 0;
  for (const photo of photos) {
    // Owner ruling 2026-11-10: photos older than the configured floor carry camera clock or name
    // errors and are ignored rather than captured or queued for review.
    if (config.earliest_capture_date && photo.parsed?.minuteKey && photo.parsed.minuteKey < config.earliest_capture_date) {
      ignored += 1;
      continue;
    }
    const resolved = resolveCaptureClient(photo.relative_path, config);
    if (resolved.held) {
      holds.push({ source_relative_path: photo.relative_path, reason: resolved.held });
      continue;
    }
    if (!photo.parsed?.minuteKey || !aucklandInstant(photo.parsed)) {
      holds.push({ source_relative_path: photo.relative_path, reason: 'capture_time_ambiguous' });
      continue;
    }
    const organizationId = resolved.client.client_organization_id;
    if (organizationId && minuteOrganizations(photo.parsed.minuteKey).has(organizationId)) {
      holds.push({ source_relative_path: photo.relative_path, reason: 'minute_has_record_review' });
      continue;
    }
    const placeKey = normalizePlace(resolved.location);
    const key = `${resolved.client.capture_code}|${placeKey}|${photo.parsed.minuteKey}`;
    const group = groups.get(key) ?? {
      capture_code: resolved.client.capture_code, client: resolved.client, location: resolved.location,
      minute_key: photo.parsed.minuteKey, log_number: logNumber(resolved.client.capture_code, placeKey, photo.parsed.minuteKey),
      plates: [], descriptions: [], photos: [],
    };
    if (photo.parsed.plate && !group.plates.includes(photo.parsed.plate)) group.plates.push(photo.parsed.plate);
    const description = photoDescription(photo.relative_path);
    if (description && !group.descriptions.includes(description)) group.descriptions.push(description);
    group.photos.push(photo.relative_path);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.capture_code.localeCompare(b.capture_code)
    || a.minute_key.localeCompare(b.minute_key) || a.log_number.localeCompare(b.log_number));
  return { groups: ordered, holds, ignored };
}

const csvCell = value => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function captureCsv(groups, config) {
  const rows = [CAPTURE_FIELDS.map(field => config.columns[field])];
  for (const group of groups) {
    const [date, time] = group.minute_key.split(' ');
    const [year, month, day] = date.split('-');
    const comments = [config.values.comment_prefix.trim(), group.descriptions.join('; ')].filter(Boolean).join(' ').slice(0, 1000);
    const values = { job: group.log_number, patroller: config.values.patroller, date: `${day}/${month}/${year}`, time,
      location: group.location, source: config.values.source, subject: config.values.subject, issue: config.values.issue,
      comments, registration: group.plates.join(', ') };
    rows.push(CAPTURE_FIELDS.map(field => values[field]));
  }
  return `${rows.map(row => row.map(value => csvCell(String(value ?? ''))).join(',')).join('\n')}\n`;
}

// Splits one client's groups into batches inside the reviewed row and new-place limits.
export function chunkCaptureGroups(groups, { maxRows, maxPlaces }) {
  const chunks = [];
  let current = [];
  let places = new Set();
  for (const group of groups) {
    const place = normalizePlace(group.location);
    if (current.length && (current.length >= maxRows || (!places.has(place) && places.size >= maxPlaces))) {
      chunks.push(current);
      current = [];
      places = new Set();
    }
    current.push(group);
    places.add(place);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// The sheet-shaped mapping a capture batch is promoted under: the client's reviewed sheet supplies
// its organisation, zone map, place suffix and aliases; the capture namespace is its own.
export function captureSheet(client, profile, config) {
  return {
    sheet: config.source_label_prefix, header_row: 1, client_code: client.capture_code,
    client_organization_id: profile.client_organization_id, zone_map: profile.zone_map,
    ...(profile.place_name_suffix ? { place_name_suffix: profile.place_name_suffix } : {}),
    ...(profile.place_aliases ? { place_aliases: profile.place_aliases } : {}),
    new_namespace: true,
  };
}

export function captureVersion(client, csv, config) {
  return { relative_path: `${config.source_label_prefix} ${client.capture_code}.csv`,
    sha256: createHash('sha256').update(csv).digest('hex'), csv };
}
