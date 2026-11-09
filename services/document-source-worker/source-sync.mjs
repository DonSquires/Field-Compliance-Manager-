import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile, lstat, realpath, opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

// The scanned workbooks are exactly the reviewed source map's workbooks (mapped or held), so a
// new client workbook is watched by adding it to the map, never by editing code.
export const patrolWorkbooks = Object.keys(JSON.parse(
  readFileSync(new URL('./rm-patrol-source-map.json', import.meta.url), 'utf8')).workbooks);

export function patrolSourcePaths() {
  return patrolWorkbooks.map(name => `Patrol Log Entries/All Log Spreadsheets/${name}`);
}

function emptyState() {
  return { version: 1, files: {} };
}

export async function loadSyncState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.version !== 1 || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
      throw new Error('Unsupported source sync state');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveSyncState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
}

async function stableFileVersion(root, relativePath, now, settleMs) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Invalid relative source path');
  }
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Source escaped its root');
  const physicalRoot = await realpath(root);
  const physicalPath = await realpath(absolutePath);
  if (!physicalPath.startsWith(`${physicalRoot}${path.sep}`)) throw new Error('Source escaped its root');
  if ((await lstat(absolutePath)).isSymbolicLink()) throw new Error('Source cannot be a symbolic link');
  const before = await stat(absolutePath);
  if (!before.isFile() || before.size === 0 || (settleMs > 0 && now - before.mtimeMs < settleMs)) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  const after = await stat(absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
  return { sha256: hash.digest('hex'), size_bytes: after.size, modified_at: after.mtime.toISOString() };
}

export async function scanSourceChanges({ root, relativePaths, state, now = Date.now(), settleMs = 5_000 }) {
  const next = structuredClone(state);
  const counts = { changed: 0, unchanged: 0, unavailable: 0, settling: 0 };
  for (const relativePath of new Set(relativePaths)) {
    try {
      const version = await stableFileVersion(root, relativePath, now, settleMs);
      if (!version) {
        counts.settling += 1;
        if (next.files[relativePath]) next.files[relativePath].availability = 'settling';
        continue;
      }
      const previous = next.files[relativePath];
      if (previous?.observed?.sha256 === version.sha256) counts.unchanged += 1;
      else counts.changed += 1;
      next.files[relativePath] = {
        ...previous,
        observed: version,
        availability: 'available',
        pending: previous?.acknowledged_sha256 !== version.sha256,
      };
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(error.code)) throw error;
      counts.unavailable += 1;
      if (next.files[relativePath]) next.files[relativePath].availability = 'unavailable';
    }
  }
  return { state: next, counts };
}

export function pendingSourceVersions(state) {
  return Object.entries(state.files)
    .filter(([, file]) => file.pending && file.availability === 'available')
    .map(([relativePath, file]) => ({ relative_path: relativePath, ...file.observed }));
}

export function acknowledgeSourceVersion(state, relativePath, receipt) {
  const file = state.files[relativePath];
  if (!file?.pending || file.availability !== 'available' || receipt?.status !== 'applied' || !receipt.receipt_id
    || receipt.source_relative_path !== relativePath
    || receipt.source_sha256 !== file.observed.sha256) {
    throw new Error('A matching applied import receipt is required');
  }
  const { hold: _resolvedHold, ...current } = file;
  return {
    ...state,
    files: {
      ...state.files,
      [relativePath]: { ...current, pending: false, acknowledged_sha256: receipt.source_sha256, receipt_id: receipt.receipt_id },
    },
  };
}

// Records why a version could not be promoted. The version stays pending (never acknowledged),
// so the hold remains visible and is re-evaluated when the file or its targets change.
export function holdSourceVersion(state, relativePath, { sha256, reason, at = new Date().toISOString() }) {
  const file = state.files[relativePath];
  if (!file?.pending || file.observed?.sha256 !== sha256 || !/^[a-z0-9_:.-]{1,120}$/i.test(reason ?? '')) {
    throw new Error('A hold must name the current pending version and a reason code');
  }
  return { ...state, files: { ...state.files, [relativePath]: { ...file, hold: { sha256, reason, at } } } };
}

export function isHeldVersion(file) {
  return Boolean(file?.hold && file.hold.sha256 === file.observed?.sha256);
}

export async function photoSourcePaths(root) {
  const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
  const found = [];
  const physicalRoot = await realpath(root);
  const photoRoot = path.join(root, 'Photos');
  if ((await lstat(photoRoot)).isSymbolicLink()
    || !(await realpath(photoRoot)).startsWith(`${physicalRoot}${path.sep}`)) {
    throw new Error('Photo source escaped its root');
  }
  async function visit(directory, relativeDirectory) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relativePath);
      else if (entry.isFile() && !entry.name.startsWith('~$') && extensions.has(path.extname(entry.name).toLowerCase())) {
        found.push(relativePath);
      }
    }
  }
  await visit(photoRoot, 'Photos');
  return found.sort();
}

export async function runSourceScan({ root, statePath, includePhotos = false, now, settleMs }) {
  let state = await loadSyncState(statePath);
  const workbooks = await scanSourceChanges({ root, relativePaths: patrolSourcePaths(), state, now, settleMs });
  state = workbooks.state;
  await saveSyncState(statePath, state);
  const summary = { workbooks: workbooks.counts, pending: pendingSourceVersions(state).length, promotion: 'not_connected' };
  if (includePhotos) {
    try {
      const relativePaths = await photoSourcePaths(root);
      const available = new Set(relativePaths);
      for (const [relativePath, file] of Object.entries(state.files)) {
        if (relativePath.startsWith('Photos/') && !available.has(relativePath)) file.availability = 'unavailable';
      }
      const photos = await scanSourceChanges({ root, relativePaths, state, now, settleMs });
      state = photos.state;
      await saveSyncState(statePath, state);
      summary.photos = photos.counts;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(error.code)) throw error;
      for (const [relativePath, file] of Object.entries(state.files)) {
        if (relativePath.startsWith('Photos/')) file.availability = 'unavailable';
      }
      await saveSyncState(statePath, state);
      summary.photos = { unavailable: true };
    }
    summary.pending = pendingSourceVersions(state).length;
  }
  return summary;
}

async function main() {
  const root = process.env.DOCUMENT_SOURCE_ROOT?.trim();
  const statePath = process.env.SOURCE_SYNC_STATE_PATH?.trim();
  const once = process.argv.includes('--once');
  if (!root || !statePath || (!once && !process.argv.includes('--watch'))) {
    throw new Error('Set DOCUMENT_SOURCE_ROOT and SOURCE_SYNC_STATE_PATH, then use --once or --watch');
  }
  const includePhotos = process.env.SOURCE_SYNC_INCLUDE_PHOTOS === 'true';
  const configuredInterval = Number(process.env.SOURCE_SYNC_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(configuredInterval) || configuredInterval < 10_000 || configuredInterval > 3_600_000) {
    throw new Error('SOURCE_SYNC_INTERVAL_MS must be between 10000 and 3600000');
  }
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  do {
    try {
      const summary = await runSourceScan({ root, statePath, includePhotos });
      console.log(JSON.stringify({ worker: 'rm-source-sync', scanned_at: new Date().toISOString(), ...summary }));
    } catch (error) {
      console.error(JSON.stringify({ worker: 'rm-source-sync', status: 'scan_failed', code: error.code ?? 'invalid_state_or_source' }));
      if (once) process.exitCode = 1;
    }
    if (once || controller.signal.aborted) break;
    try {
      await wait(configuredInterval, undefined, { signal: controller.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  } while (!controller.signal.aborted);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Source sync configuration is invalid'); process.exitCode = 1; });
}