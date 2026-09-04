const fs = require('node:fs');
const path = require('node:path');

function classifyDomain(relPath) {
  const normalized = relPath.replace(/\\/g, '/');

  if (normalized.startsWith('src/') || normalized.startsWith('supabase/') || normalized.startsWith('apps/')) return 'app';
  if (
    normalized.startsWith('scripts/') ||
    normalized.startsWith('.gitea/') ||
    normalized.startsWith('deploy/') ||
    normalized === 'bob-control-plane-server.js' ||
    normalized === 'bob-runner.js' ||
    normalized === 'assessment-manifest.js' ||
    normalized === 'worker-executor.js' ||
    normalized === 'supabase-workflow-client.js' ||
    normalized === 'package.json'
  ) return 'platform';
  if (
    normalized.startsWith('Build-Plan/') ||
    normalized === 'Build-Plan.md' ||
    normalized === 'README.md' ||
    normalized.startsWith('docs/') ||
    normalized === '.gitignore' ||
    normalized === '.env.example'
  ) return 'governance';
  if (
    normalized.startsWith('deploy/') ||
    normalized.startsWith('docker-compose') ||
    normalized.startsWith('Dockerfile') ||
    normalized.endsWith('.yml') ||
    normalized.endsWith('.yaml')
  ) return 'deployment';

  if (normalized.startsWith('.bob/')) return 'governance';

  return 'platform';
}

function readText(rootDir, relPath) {
  try {
    return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
  } catch {
    return '';
  }
}

function collectConcreteNodes(rootDir, files) {
  const nodes = [];
  const add = (type, name, domain, source) => nodes.push({ type, name, domain, source });
  const controlPlane = readText(rootDir, 'bob-control-plane-server.js');
  const routePattern = /url\.pathname\s*===\s*['"]([^'"]+)['"]/g;
  for (const match of controlPlane.matchAll(routePattern)) add('route', match[1], 'platform', 'bob-control-plane-server.js');

  for (const file of files.filter((item) => item.startsWith('supabase/functions/') && path.basename(item) === 'index.ts')) {
    add('edge_function', file.split('/')[2], 'app', file);
  }

  const schema = readText(rootDir, 'supabase/schema.sql');
  const tablePattern = /CREATE TABLE IF NOT EXISTS "public"\."([^"]+)"/g;
  for (const match of schema.matchAll(tablePattern)) add('table', match[1], 'app', 'supabase/schema.sql');

  for (const file of files.filter((item) => /^docker-compose.*\.ya?ml$/.test(path.basename(item)))) {
    const content = readText(rootDir, file);
    const serviceSection = content.split(/^services:\s*$/m)[1] || '';
    for (const match of serviceSection.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)) add('service', match[1], 'deployment', file);
  }

  return nodes.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

function buildAtlasGraph(rootDir = process.cwd()) {
  const domainSet = new Set(['app', 'platform', 'deployment', 'governance']);
  const files = [];

  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (!relPath || relPath.startsWith('.git/')) continue;

      files.push(relPath);
    }
  };

  walk(rootDir);

  const domains = Array.from(domainSet).filter((domain) => {
    return files.some((file) => classifyDomain(file) === domain);
  });
  const nodes = collectConcreteNodes(rootDir, files);

  const byDomain = new Map();
  for (const domain of domains) {
    byDomain.set(domain, []);
  }

  for (const file of files) {
    const domain = classifyDomain(file);
    if (byDomain.has(domain)) {
      byDomain.get(domain).push(file);
    }
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    domains,
    edges: [],
    nodes,
    concreteEdges: [],
    files: files.length,
    coverage: Object.fromEntries(Array.from(domainSet).map((domain) => [domain, byDomain.has(domain) ? byDomain.get(domain).length : 0]))
  };
}

function syncAtlasGraph(rootDir = process.cwd()) {
  const graph = buildAtlasGraph(rootDir);
  const artifactDir = path.join(rootDir, '.bob');
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, 'atlas-graph.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify({ ...graph, generatedBy: 'atlas-graph' }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return graph;
}

if (require.main === module) {
  const rootDir = path.resolve(process.argv[2] || process.cwd());
  const graph = syncAtlasGraph(rootDir);
  console.log(`Atlas graph ok: ${graph.domains.join(', ')} (${graph.updatedAt})`);
}

module.exports = {
  buildAtlasGraph,
  syncAtlasGraph
};
