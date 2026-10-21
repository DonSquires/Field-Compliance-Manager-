'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { baselineInfo, baselinePaths, pngEvidence, renderBaselines, sha256 } = require('../builder-visual-baseline');
const { generateVisualBaselines } = require('../builder-visual-baseline-tool');
const { validatePatchText } = require('../frontend-worker');
const { createTools, buildProposal, DEFAULT_LIMITS } = require('../builder-agentic-engineer');
const { dockerArguments } = require('../worker-executor');
const { commitVerifiedPatch } = require('../builder-branch-workspace');
const { automergeEligible } = require('../builder-autopilot');

const FILE = 'apps/web/e2e/example.spec.ts-snapshots/example-desktop-chromium-linux.png';
const OTHER = FILE.replace('example-desktop', 'other-desktop');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
const NEXT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-visual-test-'));
  const dir = path.join(root, 'source');
  fs.mkdirSync(path.dirname(path.join(dir, FILE)), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), PNG);
  fs.writeFileSync(path.join(dir, 'apps/web/e2e/example.spec.ts'), '// fixture spec\n');
  git(dir, ['init', '-q', '-b', 'bob/job-123abc']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dir;
}

test('only bounded Linux Playwright PNG paths are supported', () => {
  assert.equal(baselineInfo(FILE).project, 'desktop-chromium');
  assert.equal(baselineInfo(FILE.replace('desktop', 'mobile')).project, 'mobile-chromium');
  for (const file of ['../x.png', FILE.replace('linux', 'darwin'), 'apps/web/src/image.png', FILE.replace('example.spec', '../example.spec'), FILE.replace('.png', '.svg')]) {
    assert.throws(() => baselinePaths([file]));
  }
  assert.throws(() => baselinePaths([FILE, FILE]));
  assert.throws(() => baselinePaths(Array(7).fill(FILE)));
});

test('PNG inspection rejects malformed files, symlinks and excessive dimensions', t => {
  const dir = fixture(t);
  assert.equal(pngEvidence(dir, FILE).width, 1);
  fs.writeFileSync(path.join(dir, FILE), 'not a PNG');
  assert.throws(() => pngEvidence(dir, FILE), /not a PNG/);
  const huge = Buffer.from(PNG);
  huge.writeUInt32BE(50001, 16);
  huge.writeUInt32BE(50001, 20);
  fs.writeFileSync(path.join(dir, FILE), huge);
  assert.throws(() => pngEvidence(dir, FILE), /dimensions/);
  fs.unlinkSync(path.join(dir, FILE));
  fs.symlinkSync('/etc/passwd', path.join(dir, FILE));
  assert.throws(() => pngEvidence(dir, FILE), /symlink/);
});

test('generation keeps before/after evidence, then compares without updating snapshots', t => {
  const dir = fixture(t);
  const commands = [];
  const receipt = renderBaselines({ workDir: dir, files: [FILE], artifactDir: path.join(dir, 'artifacts'),
    run(command, args) {
      commands.push([command, ...args]);
      if (args.includes('--update-snapshots=all')) fs.writeFileSync(path.join(dir, FILE), NEXT);
      return { status: 0, command: args.join(' ') };
    } });
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('--update-snapshots=all'));
  assert.ok(!commands[1].includes('--update-snapshots=all'));
  assert.equal(receipt.before[0].sha256, sha256(PNG));
  assert.equal(receipt.after[0].sha256, sha256(NEXT));
  assert.ok(receipt.human_merge_required);
  assert.ok(fs.existsSync(path.join(dir, 'artifacts/before', FILE)));
});

test('independent verification compares restored candidate bytes, not its freshly updated baseline', t => {
  const dir = fixture(t);
  assert.throws(() => renderBaselines({ workDir: dir, files: [FILE], verifyOnly: true,
    run(_command, args) {
      if (args.includes('--update-snapshots=all')) { fs.writeFileSync(path.join(dir, FILE), NEXT); return { status: 0 }; }
      assert.deepEqual(fs.readFileSync(path.join(dir, FILE)), PNG);
      return { status: 1, stderr: 'actual render differs from candidate' };
    } }), /actual render differs/);
});

test('accepted antialiasing drift retains exact candidate bytes and both render hashes', t => {
  const dir = fixture(t);
  const receipt = renderBaselines({ workDir: dir, files: [FILE], verifyOnly: true,
    run(_command, args) {
      if (args.includes('--update-snapshots=all')) fs.writeFileSync(path.join(dir, FILE), NEXT);
      else assert.deepEqual(fs.readFileSync(path.join(dir, FILE)), PNG);
      return { status: 0 };
    } });
  assert.equal(receipt.rendered[0].sha256, sha256(NEXT));
  assert.equal(receipt.after[0].sha256, sha256(PNG));
});

test('unrequested baseline rewrites stay blocking', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, OTHER), PNG);
  assert.throws(() => renderBaselines({ workDir: dir, files: [FILE], run() {
    fs.writeFileSync(path.join(dir, OTHER), NEXT); return { status: 0 };
  } }), /unrequested screenshot/);
});

test('functional failures and missing generated files never produce successful receipts', t => {
  const dir = fixture(t);
  assert.throws(() => renderBaselines({ workDir: dir, files: [FILE], run: () => ({ status: 1, stderr: 'functional assertion failed' }) }), /functional assertion failed/);
  fs.unlinkSync(path.join(dir, FILE));
  assert.throws(() => renderBaselines({ workDir: dir, files: [FILE], run: () => ({ status: 0 }) }), /ENOENT/);
});

test('binary transport remains restricted and commits preserve exact generated PNGs', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, FILE), NEXT);
  const patch = git(dir, ['diff', '--binary']);
  assert.deepEqual(validatePatchText(patch), [FILE]);
  for (const replacement of ['apps/web/src/image.png', FILE.replace('.png', '.svg'), '../bad.png']) {
    assert.throws(() => validatePatchText(patch.replaceAll(FILE, replacement)), /binary/);
  }
  assert.throws(() => validatePatchText(patch.replace('GIT binary patch', 'Binary files a/x and b/x differ')), /binary/);
  fs.writeFileSync(path.join(dir, FILE), PNG);
  commitVerifiedPatch({ workspacePath: dir, branchName: 'bob/job-123abc', patch,
    message: 'Generated baseline candidate' });
  assert.deepEqual(fs.readFileSync(path.join(dir, FILE)), NEXT);
  assert.equal(git(dir, ['status', '--porcelain']).trim(), '');
});

test('baseline workers are network-free and never receive live test credentials', () => {
  const args = dockerArguments({ image: 'fixture', sourceDir: '/source', artifactDir: '/artifacts', profile: 'visual-baseline',
    environment: { GRANDMASTER_TEST_PASSWORD: 'not-forwarded', VERCEL_TOKEN: 'not-forwarded' },
    env: { BOB_WORKER_NETWORK: 'bob-workers' } });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.some(arg => arg.startsWith('--tmpfs=/work:')));
  assert.ok(!args.includes('--env'));
  assert.ok(!args.join(' ').includes('docker.sock'));
});

test('model edits cannot fabricate PNG provenance; dedicated tool receipts authorize handoff', async t => {
  const dir = fixture(t);
  const tools = createTools({ workspacePath: dir, repoRoot: dir, lane: 'frontend', supabase: null,
    limits: DEFAULT_LIMITS, log: () => {}, generateBaselines: async () => {
      fs.writeFileSync(path.join(dir, FILE), NEXT);
      return { receipt: { after: [pngEvidence(dir, FILE)] } };
    } });
  assert.match(tools.write_file({ path: FILE, content: 'fake' }).error, /generate_visual_baselines/);
  assert.match(tools.apply_patch({ diff: 'GIT binary patch' }).error, /refused/);
  fs.writeFileSync(path.join(dir, FILE), NEXT);
  assert.match(tools.__policyCheck(FILE), /generate_visual_baselines/);
  await tools.generate_visual_baselines({ paths: [FILE], reason: 'Intentional layout change, independently verified' });
  assert.equal(tools.__policyCheck(FILE), null);
  const result = buildProposal({ workspacePath: dir, lane: 'frontend', tools,
    args: { summary: 'Updated the intentional visual baseline with fixture verification.', tests: ['fixture comparison'] } });
  assert.ok(result.proposal.patch.includes('GIT binary patch'));
  assert.equal(result.proposal.visual_baselines[0].sha256, sha256(NEXT));
  fs.writeFileSync(path.join(dir, FILE), PNG);
  assert.match(tools.__policyCheck(FILE), /generate_visual_baselines/);
});

test('controller refuses missing worker and failed generation', async t => {
  const dir = fixture(t);
  const input = { workspacePath: dir, paths: [FILE], reason: 'The owner intentionally changed the fixture layout.' };
  await assert.rejects(generateVisualBaselines({ ...input, image: '' }), /not configured/);
  await assert.rejects(generateVisualBaselines({ ...input, image: 'test', execute: async () => ({ status: 'failed', stderr: 'assertion failure' }) }), /assertion failure/);
  await assert.rejects(generateVisualBaselines({ ...input, image: 'test', reason: 'mismatch' }), /intentional/);
});

function fakeWorker(dir, { stale = false, corrupt = false, noChange = false } = {}) {
  return async ({ artifactDir }) => {
    const before = pngEvidence(dir, FILE);
    if (!noChange) fs.writeFileSync(path.join(dir, FILE), NEXT);
    const after = pngEvidence(dir, FILE);
    const patch = noChange ? '' : git(dir, ['diff', '--binary']);
    fs.writeFileSync(path.join(dir, FILE), PNG);
    const output = path.join(artifactDir, 'after', FILE);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, noChange ? PNG : NEXT);
    const input = fs.readFileSync(path.join(artifactDir, 'input.patch'));
    const request = JSON.parse(fs.readFileSync(path.join(artifactDir, 'request.json')));
    fs.writeFileSync(path.join(artifactDir, 'baseline.patch'), patch);
    fs.writeFileSync(path.join(artifactDir, 'baseline.json'), JSON.stringify({
      succeeded: true, input_sha: request.source_sha, input_patch_sha256: sha256(input),
      patch_sha256: corrupt ? '0'.repeat(64) : sha256(Buffer.from(patch)),
      before: [before], after: [after], commands: [], independent_commands: []
    }));
    if (stale) fs.appendFileSync(path.join(dir, 'apps/web/e2e/example.spec.ts'), '// newer edit\n');
    return { status: 'succeeded' };
  };
}

test('controller binds outputs to source/diff, rejects tampering and refuses concurrent edits', async t => {
  const dir = fixture(t);
  const input = { workspacePath: dir, paths: [FILE], image: 'test',
    reason: 'Owner-approved intentional layout change, not an unexplained mismatch.' };
  await assert.rejects(generateVisualBaselines({ ...input, execute: fakeWorker(dir, { corrupt: true }) }), /provenance/);
  await assert.rejects(generateVisualBaselines({ ...input, execute: fakeWorker(dir, { stale: true }) }), /Workspace changed/);
  fs.writeFileSync(path.join(dir, 'apps/web/e2e/example.spec.ts'), '// fixture spec\n');
  const result = await generateVisualBaselines({ ...input, execute: fakeWorker(dir) });
  assert.deepEqual(result.changed_files, [FILE]);
  assert.deepEqual(fs.readFileSync(path.join(dir, FILE)), NEXT);
});

test('matching PNGs can be reverified after continuation without fabricating an edit', async t => {
  const dir = fixture(t);
  const result = await generateVisualBaselines({ workspacePath: dir, paths: [FILE], image: 'test',
    reason: 'Reverify a restored checkpoint against the intentional approved layout.',
    execute: fakeWorker(dir, { noChange: true }) });
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.receipt.after[0].sha256, sha256(PNG));
  assert.equal(git(dir, ['status', '--porcelain']).trim(), '');
});

test('even clean independently reviewed visual baselines cannot carry an auto-merge marker', () => {
  const result = automergeEligible({ env: { BOB_AUTOPILOT_AUTOMERGE: 'true' },
    job: { autopilot_requested_by: 'owner' }, evidence: {
      verifyRun: {}, verificationContract: { passed: true }, security: { passed: true },
      review: { verdict: 'passed' }, changedFiles: [FILE]
    } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /human review and merge/);
});
