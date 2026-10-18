const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { engineerCheckpoint, retireEngineerCheckpoints } = require('../builder-engineer-checkpoint');

test('engineer checkpoints survive a new store instance, are private, and reject corrupt or mismatched state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-checkpoint-'));
  const input = { workspaceRoot: root, job: { id: 'job', organization_id: 'org', target_sha: 'pin' }, step: { id: 'step' }, lane: 'frontend', inputKey: 'initial' };
  try {
    const store = engineerCheckpoint(input);
    assert.equal(store.load(), null);
    store.save({ patch: 'unfinished', completed_turns: 4 });
    assert.equal(engineerCheckpoint(input).load().patch, 'unfinished');
    assert.equal(engineerCheckpoint({ ...input, inputKey: 'repair-new-patch' }).load(), null);
    assert.equal(engineerCheckpoint({ ...input, job: { ...input.job, organization_id: 'other' } }).load(), null);
    assert.throws(() => engineerCheckpoint({ ...input, job: { ...input.job, target_sha: 'moved' } }).load(), /identity or commit/);
    const directory = path.join(root, '.engineer-checkpoints');
    const owner = path.join(directory, fs.readdirSync(directory)[0]);
    const file = path.join(owner, fs.readdirSync(owner)[0]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('unfinished', 'tampered'));
    assert.throws(() => store.load(), /checksum/);
    retireEngineerCheckpoints(root, input.job);
    assert.equal(store.load(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal retention removes checkpoints but preserves paused and approval-held work', () => {
  const { retireTerminalWorkspace } = require('../builder-branch-workspace');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-checkpoint-retention-'));
  const job = { id: 'retention-job', organization_id: 'org', target_sha: 'pin',
    status: 'failed', updated_at: '2026-09-01T00:00:00Z' };
  const store = engineerCheckpoint({ workspaceRoot: root, job, step: { id: 'step' }, lane: 'frontend', inputKey: 'initial' });
  try {
    store.save({ patch: 'saved' });
    const input = { sourceDir: root, workspaceRoot: root, job, now: Date.parse('2026-10-18T00:00:00Z') };
    assert.equal(retireTerminalWorkspace({ ...input, pendingApproval: true, dryRun: false }).removed, false);
    assert.equal(retireTerminalWorkspace({ ...input, job: { ...job, status: 'implementation_pending' }, dryRun: false }).removed, false);
    assert.equal(store.load().patch, 'saved');
    assert.equal(retireTerminalWorkspace(input).eligible, true);
    assert.equal(store.load().patch, 'saved', 'dry run preserves checkpoint');
    assert.equal(retireTerminalWorkspace({ ...input, dryRun: false }).removed, true);
    assert.equal(store.load(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
