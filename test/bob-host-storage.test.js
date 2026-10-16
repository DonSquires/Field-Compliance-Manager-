const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hostStorageStatus } = require('../bob-host-storage');

const GIB = 1024 ** 3;
const statfs = (usedGiB, totalGiB = 400) => () => ({ bsize: 4096, blocks: (totalGiB * GIB) / 4096, bfree: ((totalGiB - usedGiB) * GIB) / 4096, bavail: ((totalGiB - usedGiB) * GIB) / 4096 });

test('host storage reports live disk pressure and the last hygiene receipt', () => {
  const report = JSON.stringify({ checked_at: '2026-10-16T02:52:00Z', freed_bytes: 150 * GIB, gitea_backups_kept: 3 });
  const status = hostStorageStatus({ stateDir: '/data', statfs: statfs(343), readFile: () => report });
  assert.equal(status.status, 'warn');
  assert.equal(status.used_pct, 85.8);
  assert.equal(status.available_gb, 57);
  assert.deepEqual(status.last_hygiene, { checked_at: '2026-10-16T02:52:00Z', freed_gb: 150, gitea_backups_kept: 3 });
  assert.equal(hostStorageStatus({ stateDir: '/data', statfs: statfs(370), readFile: () => { throw new Error('missing'); } }).status, 'critical');
  assert.equal(hostStorageStatus({ stateDir: '/data', statfs: statfs(100), readFile: () => '{}' }).status, 'ok');
  assert.equal(hostStorageStatus({ stateDir: '/data', statfs: () => { throw new Error('no statfs'); } }).status, 'unknown');
});

test('storage hygiene is repo-managed: count-based Gitea retention, space guard, evidence untouched (incident 2026-10-16: 202 GB of dumps)', () => {
  const backup = fs.readFileSync(path.resolve(__dirname, '../deploy/bob-vps/host/fcm-gitea-backup'), 'utf8');
  const cleanup = fs.readFileSync(path.resolve(__dirname, '../deploy/bob-vps/host/vps-disk-cleanup.sh'), 'utf8');
  const deploy = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-vps-deploy.sh'), 'utf8');
  assert.match(backup, /keep="\$\{GITEA_BACKUP_KEEP:-3\}"/);
  assert.match(backup, /free_bytes < need_bytes/, 'a dump that cannot fit is skipped, never allowed to fill the disk');
  assert.ok(backup.indexOf('mv "$out/.gitea-') < backup.indexOf('tail -n +$(( keep + 1 ))'), 'old dumps retire only after the new dump completes');
  assert.doesNotMatch(backup, /-mtime \+14 -delete/);
  assert.match(cleanup, /storage-hygiene\.json/);
  assert.doesNotMatch(cleanup.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'), /vision-derived|ollama-models|gitea_data|builder-workspaces/);
  assert.match(deploy, /host-hygiene\)/);
  assert.match(deploy, /install -m 755 deploy\/bob-vps\/host\/fcm-gitea-backup \/usr\/local\/sbin\/fcm-gitea-backup/);
  const server = fs.readFileSync(path.resolve(__dirname, '../bob-control-plane-server.js'), 'utf8');
  assert.match(server, /storage: hostStorageStatus\(\{ stateDir \}\)/);
});
