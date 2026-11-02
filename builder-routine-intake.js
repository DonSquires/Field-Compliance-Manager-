'use strict';

// Routine self-heal intake. A monitored friction packet carries the page and the error message but no stack
// (privacy by design), so the brief points the author at the shared root cause when the failure signature is
// known, and packets that share a signature are repaired by one Builder job instead of one job per page
// (live 2026-11: `_leaflet_pos` opened and failed separate jobs for /admin/hub and /admin/module-subscriptions).

const KNOWN_SIGNATURES = [
  {
    id: 'stale_code_split_chunk',
    pattern: /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|chunkloaderror|loading (?:css )?chunk [\w-]+ failed/i,
    cause: 'the browser is still running a previous deployment and requested a code-split JavaScript or CSS chunk that the new deployment replaced',
    guidance: 'Repair the shared lazy-load recovery, not the page module: LazyPageRecovery in apps/web/src/shells/AdminShell.tsx and one window "vite:preloadError" handler at the app entry (apps/web/src/main.tsx) should reload once to the current build for both JavaScript and CSS preload failures, without a reload loop, and apps/web/src/lib/bobFrictionMonitor.ts must not report a chunk failure the app recovers from automatically.',
    files: ['apps/web/src/shells/AdminShell.tsx', 'apps/web/src/main.tsx', 'apps/web/src/lib/bobFrictionMonitor.ts'],
  },
  {
    id: 'leaflet_after_unmount',
    pattern: /_leaflet_pos|_leaflet_id|_leaflet_events/i,
    cause: 'a Leaflet map is still animating or resizing (fitBounds, flyTo, setView, invalidateSize, a zoom/pan transition, or a timer) after its container left the page',
    guidance: 'Repair the shared map component, not the page: find which Leaflet map the page renders (apps/web/src/components/LocationHouseMap.tsx, apps/web/src/components/FieldPointMap.tsx, apps/web/src/components/OfficerRouteGuidance.tsx, or a map in apps/web/src/shells/AdminShell.tsx), then stop pending animations and timers, skip view changes once the container is gone, and remove the map exactly once on unmount.',
    files: ['apps/web/src/components/LocationHouseMap.tsx', 'apps/web/src/components/FieldPointMap.tsx', 'apps/web/src/components/OfficerRouteGuidance.tsx', 'apps/web/src/shells/AdminShell.tsx'],
  },
  {
    id: 'postgrest_server_error',
    pattern: /\brest\/[\w.]+ (?:return(?:ed)? )?http 5\d\d\b|\brest\/[\w.]+\b[^\n]*\breturned 5\d\d\b/i,
    cause: 'the database raised an error for a PostgREST read, so the page cannot load its data',
    guidance: 'Find the failing relation or RPC in supabase/schema.sql (view body, function, grants, and row-level security helpers it calls) and reproduce the error with a read-only query before changing code. If the root cause is in the database, repair it with one new additive migration in supabase/migrations/; the release then waits for Grandmaster approval. If the page sends an invalid query, repair the caller. Never weaken a policy to make an error disappear.',
    files: [],
  },
];

function plain(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function packetFailure(packet) {
  const envelope = packet?.envelope && typeof packet.envelope === 'object' ? packet.envelope : {};
  const during = envelope.during && typeof envelope.during === 'object' ? envelope.during : {};
  const error = during.error && typeof during.error === 'object' ? during.error : {};
  const failed = during.failed_request && typeof during.failed_request === 'object' ? during.failed_request : {};
  return { envelope, during, error, failed };
}

/** Lower-case failure text with deployment-specific noise (URLs, paths, hashes, ids) removed. */
function normalizeFailureText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(^|[\s(])\/[\w\-./:%]*/g, '$1<path>')
    .replace(/\b[\w-]+-[a-z0-9_]{6,}\.(?:m?js|css)\b/gi, '<asset>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/g, '<hex>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function knownSignatureFor(packet) {
  const { error, failed } = packetFailure(packet);
  const text = `${error.message ?? ''}\n${error.name ?? ''}\n${failed.fn || failed.route ? `${failed.fn || failed.route} returned ${failed.status ?? ''}` : ''}`;
  return KNOWN_SIGNATURES.find((signature) => signature.pattern.test(text)) || null;
}

/** Page-independent identity of a monitored failure: packets with the same signature share one repair. */
function routineSignature(packet) {
  const { error, failed } = packetFailure(packet);
  const known = knownSignatureFor(packet);
  if (known && known.id !== 'postgrest_server_error') return `known:${known.id}`;
  const request = failed.fn || failed.route ? `${normalizeFailureText(failed.fn || failed.route)}:${Number(failed.status) || ''}` : '';
  return [plain(error.kind || 'runtime_error', 80).toLowerCase(), normalizeFailureText(error.message), request].join('|');
}

function packetPage(packet) {
  return plain(packetFailure(packet).envelope.before?.page || 'unknown', 500);
}

function routineRepairBrief(packet, { alsoReported = [] } = {}) {
  const { envelope, error, failed } = packetFailure(packet);
  const before = envelope.before && typeof envelope.before === 'object' ? envelope.before : {};
  const expected = envelope.expected && typeof envelope.expected === 'object' ? envelope.expected : {};
  const known = knownSignatureFor(packet);
  const pages = [...new Set(alsoReported.map(packetPage).filter((page) => page && page !== packetPage(packet)))].slice(0, 12);
  return [
    `Goal: repair the routine monitored defect recorded in friction packet ${packet.id}.`,
    `Before: page ${String(before.page || 'unknown').slice(0, 500)}; module ${String(before.module || 'unknown').slice(0, 120)}; user intended ${String(expected.user_intent || 'continue the workflow').slice(0, 1000)}.`,
    `During: ${String(error.kind || 'runtime_error').slice(0, 80)} — ${String(error.message || 'unhandled application error').slice(0, 500)}${failed.status ? `; request ${String(failed.fn || failed.route || 'unknown').slice(0, 200)} returned ${Number(failed.status)}` : ''}.`,
    `After: ${String(expected.expected_outcome || 'the workflow remains usable and exposes an explicit recoverable state').slice(0, 1000)}.`,
    ...(pages.length ? [`Also reported on: ${pages.join(', ')} with the same failure signature; one root-cause repair must fix every listed page.`] : []),
    ...(known ? [
      `Known signature: ${known.cause}.`,
      `Root-cause guidance: ${known.guidance}${known.files.length ? ` Likely shared files: ${known.files.join(', ')}.` : ''}`,
    ] : []),
    'Required investigation: read canon, query Atlas capability/direct edges/blast radius, cross-check supabase/schema.sql, search the repository for the failing symbol, relation, or message (the page named above is where it surfaced, not necessarily where it lives), and identify the smallest root-cause fix. When the root cause is in a shared file outside a requirement\'s page scope, repair the shared file and record a scope_amendment with the reason.',
    'Required verification: targeted tests, independent review, before/during/after data-path evidence, Atlas refresh, schema/data-path check, and human-glass acceptance for any web change.',
    'Routine boundary: make the smallest corrective patch that removes the root cause. Do not redesign, add a feature/module/workflow, change architecture, change dependencies/environment/secrets/authentication, or touch legal, safety, identity, enforcement, finance, payroll, or evidential truth. A database root cause may be repaired with one new additive migration; any migration holds at the release gate for Grandmaster approval. If the fix needs anything else outside this boundary, stop and escalate for Grandmaster review.',
    `Triage basis: ${JSON.stringify(packet.basis || {}).slice(0, 1800)}.`,
  ].join('\n');
}

/**
 * Split claimed packets into repairs to open and packets already covered by an open repair.
 * `openRepairs` is [{ jobId, signature }] for routine jobs that are still running.
 */
function planRoutineIntake(packets, openRepairs = []) {
  const open = new Map();
  for (const repair of openRepairs) {
    if (repair?.jobId && repair.signature && !open.has(repair.signature)) open.set(repair.signature, repair.jobId);
  }
  const leaders = new Map();
  const covered = [];
  for (const packet of Array.isArray(packets) ? packets : []) {
    const signature = routineSignature(packet);
    if (open.has(signature)) {
      covered.push({ packet, jobId: open.get(signature), signature });
    } else if (leaders.has(signature)) {
      leaders.get(signature).followers.push(packet);
    } else {
      leaders.set(signature, { packet, signature, followers: [] });
    }
  }
  return { repairs: [...leaders.values()], covered };
}

module.exports = {
  KNOWN_SIGNATURES,
  knownSignatureFor,
  normalizeFailureText,
  planRoutineIntake,
  routineRepairBrief,
  routineSignature,
};
