const PLATE_PATTERN = '(?:[A-Z]{2,3}[ _-]?[0-9]{2,4}|[0-9]{1,3}[ _-]?[A-Z]{2,3})';
const AUCKLAND_MINUTE_FORMATTER = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function normalizePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizePlace(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function minuteKey(year, month, day, hour, minute) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parsePhotoName(fileName) {
  const stem = String(fileName ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toUpperCase();
  const dateFirst = new RegExp(`(?:^|[^0-9])([0-9]{6})[ _-]+([0-9]{4}(?:[0-9]{2})?)(?:[ _-]+(${PLATE_PATTERN}))?(?:[^A-Z0-9]|$)`).exec(stem);
  const plateFirst = new RegExp(`(?:^|[^A-Z0-9])(${PLATE_PATTERN})[ _-]+([0-9]{6})[ _-]+([0-9]{4}(?:[0-9]{2})?)(?:[^0-9]|$)`).exec(stem);
  const match = dateFirst
    ? { date: dateFirst[1], time: dateFirst[2], plate: dateFirst[3] ?? null }
    : plateFirst
      ? { plate: plateFirst[1], date: plateFirst[2], time: plateFirst[3] }
      : null;
  if (!match) return null;

  const year = 2000 + Number(match.date.slice(0, 2));
  const month = Number(match.date.slice(2, 4));
  const day = Number(match.date.slice(4, 6));
  const paddedTime = match.time.length === 4 ? `${match.time}00` : match.time;
  const hour = Number(paddedTime.slice(0, 2));
  const minute = Number(paddedTime.slice(2, 4));
  const second = Number(paddedTime.slice(4, 6));
  const clock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    clock.getUTCFullYear() !== year
    || clock.getUTCMonth() !== month - 1
    || clock.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;

  return {
    plate: normalizePlate(match.plate) || null,
    localClockMs: clock.getTime(),
    minuteKey: minuteKey(year, month, day, hour, minute),
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

export function aucklandMinuteKey(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(AUCKLAND_MINUTE_FORMATTER.formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return minuteKey(Number(values.year), Number(values.month), Number(values.day), Number(values.hour), Number(values.minute));
}

export function aucklandInstant(parsed) {
  if (!Number.isFinite(parsed?.localClockMs) || !parsed.minuteKey) return null;
  const candidates = [];
  for (const offsetHours of [13, 12]) {
    const candidate = new Date(parsed.localClockMs - offsetHours * 60 * 60 * 1000);
    if (aucklandMinuteKey(candidate) === parsed.minuteKey) candidates.push(candidate.toISOString());
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function aucklandInstantFromLocalParts(year, month, day, hour, minute, second = 0) {
  const values = [year, month, day, hour, minute, second].map(Number);
  if (!values.every(Number.isInteger)) return null;
  const [localYear, localMonth, localDay, localHour, localMinute, localSecond] = values;
  const localClock = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond));
  if (
    localYear < 2000
    || localClock.getUTCFullYear() !== localYear
    || localClock.getUTCMonth() !== localMonth - 1
    || localClock.getUTCDate() !== localDay
    || localHour < 0 || localHour > 23
    || localMinute < 0 || localMinute > 59
    || localSecond < 0 || localSecond > 59
  ) return null;
  return aucklandInstant({
    localClockMs: localClock.getTime(),
    minuteKey: minuteKey(localYear, localMonth, localDay, localHour, localMinute),
  });
}

export function extractPlateCandidates(value) {
  const plates = new Set();
  const pattern = new RegExp(`(?:^|[^A-Z0-9])(${PLATE_PATTERN})(?=$|[^A-Z0-9])`, 'gi');
  for (const match of String(value ?? '').matchAll(pattern)) {
    const plate = normalizePlate(match[1]);
    if (plate) plates.add(plate);
  }
  return plates;
}

export function indexPhotoTargets(targets) {
  const index = new Map();
  for (const target of targets) {
    const key = aucklandMinuteKey(target.observed_at);
    if (!key) continue;
    const rows = index.get(key) ?? [];
    rows.push({
      ...target,
      plateCandidates: new Set([
        normalizePlate(target.plate_number),
        ...extractPlateCandidates(target.officer_notes),
      ].filter(Boolean)),
      placeAliases: new Set((target.place_aliases ?? []).map(normalizePlace).filter(Boolean)),
    });
    index.set(key, rows);
  }
  return index;
}

export function matchPhotoTarget(parsed, relativePath, targetsByMinute) {
  const candidates = targetsByMinute.get(parsed.minuteKey) ?? [];
  const folderPlaces = String(relativePath ?? '').replaceAll('\\', '/').split('/').slice(1, -1)
    .map(normalizePlace).filter(Boolean);
  const matched = candidates.filter((target) => parsed.plate
    ? target.plateCandidates.has(parsed.plate)
    : folderPlaces.some((place) => target.placeAliases.has(place)));
  const unique = [...new Map(matched.map((target) => [target.id, target])).values()];
  if (unique.length === 1) return { status: 'matched', target: unique[0], matchType: parsed.plate ? 'rego' : 'place' };
  return { status: unique.length > 1 ? 'ambiguous' : 'unmatched', target: null };
}