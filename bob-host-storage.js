'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GIB = 1024 ** 3;

// Live disk truth for Bob's host plus the last nightly hygiene receipt
// (deploy/bob-vps/host/vps-disk-cleanup.sh). The state directory is a bind mount of the host's
// /var/lib/bob, so statfs reports the host root filesystem.
function hostStorageStatus({ stateDir, statfs = fs.statfsSync, readFile = fs.readFileSync, warnPct = 80, criticalPct = 90 } = {}) {
  let disk;
  try {
    const stats = statfs(stateDir);
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const used = total - stats.bfree * stats.bsize;
    const usedPct = total > 0 ? Math.round((used / total) * 1000) / 10 : null;
    disk = {
      total_gb: Math.round(total / GIB),
      available_gb: Math.round(available / GIB),
      used_pct: usedPct,
      status: usedPct == null ? 'unknown' : usedPct >= criticalPct ? 'critical' : usedPct >= warnPct ? 'warn' : 'ok',
    };
  } catch {
    disk = { status: 'unknown' };
  }
  let lastHygiene = null;
  try {
    const report = JSON.parse(readFile(path.join(stateDir, 'storage-hygiene.json'), 'utf8'));
    lastHygiene = {
      checked_at: typeof report.checked_at === 'string' ? report.checked_at : null,
      freed_gb: Number.isFinite(report.freed_bytes) ? Math.round((report.freed_bytes / GIB) * 10) / 10 : null,
      gitea_backups_kept: Number.isFinite(report.gitea_backups_kept) ? report.gitea_backups_kept : null,
    };
  } catch {}
  return { ...disk, last_hygiene: lastHygiene };
}

module.exports = { hostStorageStatus };
