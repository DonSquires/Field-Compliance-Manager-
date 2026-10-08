const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const IGNORED_PARTS = new Set(['.git', 'node_modules', '.env', 'bob-data', '.temp']);
const SECRET_NAME = /(password|secret|token|api[_-]?key|private[_-]?key|service[_-]?role)/i;

function listFiles(rootDir) {
  const files = [];
  function visit(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (IGNORED_PARTS.has(entry.name) || entry.name.startsWith('.env')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else files.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
    }
  }
  visit(rootDir);
  return files.sort();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function git(rootDir, args) {
  try {
    return execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function composeServices(rootDir, files) {
  return files
    .filter(file => /^docker-compose.*\.ya?ml$/.test(path.basename(file)))
    .map(file => {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      const lines = content.split('\n');
      const start = lines.findIndex(line => line.trim() === 'services:');
      const services = [];
      if (start >= 0) {
        for (const line of lines.slice(start + 1)) {
          if (line && !/^[ \t]/.test(line)) break;
          const match = line.match(/^  ([a-zA-Z0-9_-]+):$/);
          if (match) services.push(match[1]);
        }
      }
      return { file, services };
    });
}

function edgeFunctions(rootDir, files) {
  return files
    .filter(file => file.startsWith('supabase/functions/') && path.basename(file) === 'index.ts')
    .map(file => file.split('/')[2])
    .filter(Boolean)
    .sort();
}

function createAssessment(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new Error('source directory is required');
  const files = listFiles(resolvedRoot);
  const packageFiles = files.filter(file => path.basename(file) === 'package.json');
  const packages = packageFiles.map(file => {
    const packageJson = readJson(path.join(resolvedRoot, file));
    return packageJson ? { file, name: packageJson.name || null, scripts: Object.keys(packageJson.scripts || {}), dependencies: Object.keys(packageJson.dependencies || {}) } : { file, invalid: true };
  });
  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: resolvedRoot,
    git: {
      branch: git(resolvedRoot, ['branch', '--show-current']),
      commit: git(resolvedRoot, ['rev-parse', 'HEAD']),
      recentCommits: (git(resolvedRoot, ['log', '-5', '--format=%h %s']) || '').split('\n').filter(Boolean),
      status: (git(resolvedRoot, ['status', '--short']) || '').split('\n').filter(Boolean).map(line => line.slice(0, 120))
    },
    fileCount: files.length,
    files,
    packages,
    compose: composeServices(resolvedRoot, files),
    supabaseEdgeFunctions: edgeFunctions(resolvedRoot, files),
    secretFilesExcluded: true,
    secretNamePattern: SECRET_NAME.source
  };
}

if (require.main === module) {
  const sourceDir = process.argv[2];
  const outputPath = process.argv[3] || path.resolve('bob-artifacts/system-assessment.json');
  if (!sourceDir) {
    console.error('usage: node assessment-manifest.js <source-dir> [output-path]');
    process.exitCode = 2;
  } else {
    try {
      const assessment = createAssessment(sourceDir);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(assessment, null, 2)}\n`, { mode: 0o600 });
      console.log(`assessment written: ${outputPath}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { createAssessment, listFiles };
