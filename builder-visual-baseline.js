'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BASELINES = 6;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const BASELINE_PATH = /^apps\/web\/(e2e\/[A-Za-z0-9_/-]+\.spec\.ts)-snapshots\/[A-Za-z0-9_-]+-(desktop|mobile)-chromium-linux\.png$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function baselineInfo(file) {
  const match = typeof file === 'string' && BASELINE_PATH.exec(file);
  if (!match) return null;
  return { path: file, spec: match[1], project: `${match[2]}-chromium` };
}

function baselinePaths(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_BASELINES
    || files.some(file => !baselineInfo(file)) || new Set(files).size !== files.length) {
    throw new Error(`Provide one to ${MAX_BASELINES} distinct Playwright Linux PNG baseline paths`);
  }
  return [...files].sort();
}

function safeFile(root, file, { optional = false } = {}) {
  const parts = file.split('/');
  let current = path.resolve(root);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\')) throw new Error('Unsafe baseline path');
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Baseline path contains a symlink: ${file}`);
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  if (!fs.statSync(current).isFile()) throw new Error(`Baseline path is not a regular file: ${file}`);
  return current;
}

function pngEvidence(root, file, { optional = false } = {}) {
  const absolute = safeFile(root, file, { optional });
  if (!absolute) return null;
  const stat = fs.statSync(absolute);
  if (stat.size > MAX_PNG_BYTES) throw new Error(`Baseline exceeds PNG size limit: ${file}`);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`Baseline is not a PNG: ${file}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 50_000_000) throw new Error(`Baseline dimensions exceed limits: ${file}`);
  return { path: file, sha256: sha256(bytes), bytes: bytes.length, width, height };
}

function snapshotInventory(root) {
  const entries = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not permitted in baseline fixtures');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.png') && absolute.includes('.spec.ts-snapshots/')) {
        entries[path.relative(root, absolute).split(path.sep).join('/')] = sha256(fs.readFileSync(absolute));
      }
    }
  };
  visit(path.join(root, 'apps/web/e2e'));
  return entries;
}

function renderBaselines({ workDir, files, run, artifactDir, verifyOnly = false }) {
  const paths = baselinePaths(files);
  const inventory = snapshotInventory(workDir);
  const before = paths.map(file => pngEvidence(workDir, file, { optional: !verifyOnly }));
  const candidates = verifyOnly ? new Map(paths.map(file => [file, fs.readFileSync(safeFile(workDir, file))])) : null;
  const rendered = [];
  if (artifactDir) {
    for (const item of before.filter(Boolean)) {
      const target = path.join(artifactDir, 'before', item.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(safeFile(workDir, item.path), target);
    }
  }
  const commands = [];
  const projects = [...new Set(paths.map(file => baselineInfo(file).project))];
  for (const project of projects) {
    const specs = [...new Set(paths.filter(file => baselineInfo(file).project === project).map(file => baselineInfo(file).spec))];
    for (const update of [true, false]) {
      const args = ['run', 'test:e2e', '--prefix', 'apps/web', '--', ...specs, `--project=${project}`, '--workers=1', '--reporter=line', ...(update ? ['--update-snapshots=all'] : [])];
      const result = run('npm', args, { cwd: workDir });
      commands.push(result);
      if (result.status !== 0 || result.error) throw new Error(`Baseline ${update ? 'generation' : 'comparison'} failed: ${result.error || result.stderr || result.stdout}`.slice(0, 3000));
      if (update && verifyOnly) {
        for (const file of paths.filter(file => baselineInfo(file).project === project)) {
          rendered.push(pngEvidence(workDir, file));
          if (artifactDir) {
            const target = path.join(artifactDir, 'rendered', file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(safeFile(workDir, file), target);
          }
          fs.writeFileSync(safeFile(workDir, file), candidates.get(file));
        }
      }
    }
  }
  const after = paths.map(file => pngEvidence(workDir, file));
  const nextInventory = snapshotInventory(workDir);
  if ([...new Set([...Object.keys(inventory), ...Object.keys(nextInventory)])]
    .some(file => !paths.includes(file) && inventory[file] !== nextInventory[file])) {
    throw new Error('Baseline generation changed an unrequested screenshot');
  }
  if (artifactDir) {
    for (const item of after) {
      const target = path.join(artifactDir, 'after', item.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(safeFile(workDir, item.path), target);
    }
  }
  if (verifyOnly && after.some((item, index) => item.sha256 !== before[index]?.sha256)) throw new Error('Independent verification altered candidate bytes');
  return { before, after, rendered, commands, fixture_only: true, human_merge_required: true,
    comparison: 'Existing spec assertions and tolerances; candidate bytes restored before comparison' };
}

module.exports = { MAX_BASELINES, baselineInfo, baselinePaths, pngEvidence, renderBaselines, safeFile, sha256 };
