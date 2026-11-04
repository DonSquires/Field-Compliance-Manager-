// Resolves an R&M patrol-log row's Reserve code / Location text to a mapped place.
// Owner ruling 2026-11-04: an unknown location still becomes a place, but spelling
// slips ("Sepentine Rd", "Spooners Rd" for "Spooners Gate") must land on the existing
// place rather than create a near-duplicate. Reserve codes are short abbreviations,
// so they only ever match case-insensitively; spelling tolerance applies to the
// free-text Location, and only when it points at exactly one place.

const ABBREVIATIONS = new Map([
  ['rd', 'road'], ['st', 'street'], ['ave', 'avenue'], ['hwy', 'highway'], ['mt', 'mount'],
  ['sh', 'state highway'], ['ck', 'creek'], ['crk', 'creek'], ['rv', 'river'],
]);

// Words that say what kind of place it is, not which place it is.
const GENERIC_WORDS = new Set([
  'road', 'street', 'avenue', 'highway', 'state', 'lane', 'drive', 'gate', 'gates', 'forest', 'forests',
  'reserve', 'block', 'track', 'link', 'entrance', 'main', 'the', 'and', 'of', 'at', 'end', 'top', 'bottom',
  'north', 'south', 'east', 'west', 'upper', 'lower', 'onefortyone', 'ofo',
]);

export function placeKey(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map((word) => ABBREVIATIONS.get(word) ?? word).join(' ');
}

function distinctiveWords(key) {
  return key.split(' ').filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word) && !/^[0-9]+$/.test(word));
}

// One inserted, deleted, substituted or swapped letter, for words long enough that a
// single slip cannot turn one real place name into another.
function sameWord(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((ch, i) => (ch === b[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

function sameWords(left, right) {
  return left.length > 0 && left.length === right.length
    && left.every((word) => right.some((other) => sameWord(word, other)))
    && right.every((word) => left.some((other) => sameWord(word, other)));
}

const targetKey = (target) => (typeof target === 'string' ? target : JSON.stringify(target));

export function buildPlaceResolver(zoneMap) {
  const entries = Object.entries(zoneMap ?? {}).filter(([, target]) => target);
  const byUpper = new Map();
  const byKey = new Map();
  for (const [name, target] of entries) {
    const upper = name.trim().toUpperCase();
    if (!byUpper.has(upper)) byUpper.set(upper, target);
    const key = placeKey(name);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(target);
    byKey.set(key, list);
  }
  const named = [...byKey.entries()].map(([key, targets]) => ({ words: distinctiveWords(key), targets }));
  const unique = (targets) => {
    const distinct = [...new Map(targets.map((target) => [targetKey(target), target])).values()];
    return distinct.length === 1 ? distinct[0] : null;
  };

  return function resolvePlace(reserveCode, locationText) {
    const code = String(reserveCode ?? '').trim();
    const text = String(locationText ?? '').trim();
    if (code && zoneMap[code]) return { target: zoneMap[code], match: 'reserve' };
    if (text && zoneMap[text]) return { target: zoneMap[text], match: 'location' };
    if (code && byUpper.has(code.toUpperCase())) return { target: byUpper.get(code.toUpperCase()), match: 'reserve_case' };
    if (text && byUpper.has(text.toUpperCase())) return { target: byUpper.get(text.toUpperCase()), match: 'location_case' };
    const key = placeKey(text);
    if (key) {
      const exact = unique(byKey.get(key) ?? []);
      if (exact) return { target: exact, match: 'location_normalised' };
      const words = distinctiveWords(key);
      if (words.length) {
        const near = unique(named.filter((place) => sameWords(words, place.words)).flatMap((place) => place.targets));
        if (near) return { target: near, match: 'location_spelling' };
      }
    }
    return { target: null, match: null, placeName: newPlaceName(code, text) };
  };
}

// The name a new place is registered under, or null when the row carries nothing that
// identifies a place (blank, a single letter, a bare number) and needs a person to look.
export function newPlaceName(reserveCode, locationText) {
  const text = String(locationText ?? '').replace(/\s+/g, ' ').trim();
  const code = String(reserveCode ?? '').replace(/\s+/g, ' ').trim();
  for (const candidate of [text, code]) {
    if (/[A-Za-z]{3,}/.test(candidate) && candidate.length <= 80) return candidate;
  }
  return null;
}
