const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createAssessment } = require('../../../assessment-manifest');

const MAX_TRACKED_FILES = 2000;
const MAX_SCHEMA_ENTITIES = 1000;
const EXCLUDED_PATH = /(?:^|\/)\.env(?:\.|$)/;

function git(sourceDir, args) {
  return execFileSync('git', args, { cwd: sourceDir, encoding: 'utf8' }).trim();
}

function schemaEntities(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]).filter(Boolean).sort().slice(0, MAX_SCHEMA_ENTITIES);
}

function collectSchemaInventory(sourceDir) {
  const schemaPath = `${sourceDir}/supabase/schema.sql`;
  if (!fs.existsSync(schemaPath)) return { available: false, tables: [], views: [], functions: [] };
  const schema = fs.readFileSync(schemaPath, 'utf8');
  return {
    available: true,
    tables: schemaEntities(schema, /CREATE TABLE(?: IF NOT EXISTS)? "public"\."([^"]+)"/g),
    views: schemaEntities(schema, /CREATE(?: OR REPLACE)? VIEW "public"\."([^"]+)"/g),
    functions: schemaEntities(schema, /CREATE OR REPLACE FUNCTION "public"\."([^"]+)"/g)
  };
}

function collectRepositoryContext({ sourceDir, targetSha }) {
  if (!sourceDir || !targetSha) throw new Error('sourceDir and targetSha are required');
  if (git(sourceDir, ['rev-parse', 'HEAD']) !== targetSha) {
    throw new Error('repository HEAD does not match target SHA');
  }
  if (git(sourceDir, ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('repository context requires a clean checkout');
  }
  const files = git(sourceDir, ['ls-tree', '-r', '--name-only', targetSha])
    .split('\n')
    .filter(file => file && !EXCLUDED_PATH.test(file));
  if (files.length > MAX_TRACKED_FILES) throw new Error('repository inventory exceeds file limit');
  const assessment = createAssessment(sourceDir);
  return {
    target_sha: targetSha,
    file_count: files.length,
    tracked_files: files,
    packages: assessment.packages,
    compose: assessment.compose,
    supabase_edge_functions: assessment.supabaseEdgeFunctions,
    schema: collectSchemaInventory(sourceDir),
    recent_commits: assessment.git.recentCommits,
    secret_files_excluded: true
  };
}

module.exports = { MAX_TRACKED_FILES, MAX_SCHEMA_ENTITIES, EXCLUDED_PATH, collectSchemaInventory, collectRepositoryContext };