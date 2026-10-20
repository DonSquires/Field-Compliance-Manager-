const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createAssessment } = require('../../../assessment-manifest');

const MAX_TRACKED_FILES = 2000;
const MAX_SCHEMA_ENTITIES = 1000;
const EXCLUDED_PATH = /(?:^|\/)\.env(?:\.|$)/;
// Trimmed first when the inventory must be bounded: the schema inventory already
// carries the database truth, so individual migration files are the lowest-signal
// entries for a model reading the build map.
const LOW_SIGNAL_PATH = /^supabase\/migrations\//;

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

function directoryCounts(files) {
  const counts = new Map();
  for (const file of files) {
    const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '.';
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

// The full inventory is only bounded, never a reason to fail: consumers already
// slice tracked_files, and a repository that grows past the cap must still build.
function boundTrackedFiles(files, taskDescription = '') {
  if (taskDescription) files = keepRelevantFirst(files, relevanceTerms(taskDescription), files.length);
  if (files.length <= MAX_TRACKED_FILES) return { tracked_files: files, truncated: false };
  const primary = files.filter(file => !LOW_SIGNAL_PATH.test(file));
  const lowSignal = files.filter(file => LOW_SIGNAL_PATH.test(file));
  return { tracked_files: [...primary, ...lowSignal].slice(0, MAX_TRACKED_FILES), truncated: true };
}

function collectRepositoryContext({ sourceDir, targetSha, taskDescription = '' }) {
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
  const bounded = boundTrackedFiles(files, taskDescription);
  const assessment = createAssessment(sourceDir);
  const context = {
    target_sha: targetSha,
    file_count: files.length,
    tracked_files: bounded.tracked_files,
    tracked_files_truncated: bounded.truncated,
    directory_counts: directoryCounts(files),
    packages: assessment.packages,
    compose: assessment.compose,
    supabase_edge_functions: assessment.supabaseEdgeFunctions,
    schema: collectSchemaInventory(sourceDir),
    recent_commits: assessment.git.recentCommits,
    secret_files_excluded: true
  };
  // Grounding needs the whole inventory; prompts and artifacts only ever serialize the bounded list.
  Object.defineProperty(context, 'all_tracked_files', { value: files, enumerable: false });
  return context;
}

// A local model's window (24-40k tokens) cannot hold the full build map: the file list and schema names
// alone exceeded it and every in-house analyst call failed at step one (2026-09-27). Keep what the brief
// names, then whatever else fits; the engineer reads the rest of the repository itself.
const DEFAULT_CONTEXT_MAX_CHARS = 40000;

function relevanceTerms(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[a-z][a-z0-9_./-]{3,}/g) || []).map(term => term.replace(/[.,;:]+$/, '')))];
}

function keepRelevantFirst(list, terms, cap) {
  const items = Array.isArray(list) ? list.filter(value => typeof value === 'string') : [];
  const relevant = name => {
    const lower = name.toLowerCase();
    const base = lower.split('/').pop().replace(/\.[a-z0-9]+$/, '');
    return terms.some(term => lower.includes(term) || (base.length >= 4 && term.includes(base)));
  };
  const hits = items.filter(relevant);
  const hitSet = new Set(hits);
  return [...hits, ...items.filter(item => !hitSet.has(item))].slice(0, cap);
}

function fitRepositoryContext(context, task, maxChars = Number(process.env.BOB_BUILDER_CONTEXT_MAX_CHARS || DEFAULT_CONTEXT_MAX_CHARS)) {
  if (!context || typeof context !== 'object') return context;
  const size = () => JSON.stringify(context).length;
  if (size() <= maxChars) return context;
  const terms = relevanceTerms(task);
  // collectRepositoryContext puts the build map at the top level; the analyst/designer normalisers nest it
  // under build_map. Trim whichever shape holds the file list (the engineer passed the raw shape, 2026-09-27).
  const nested = context.build_map && typeof context.build_map === 'object' && Array.isArray(context.build_map.tracked_files);
  const buildMap = nested ? context.build_map : context;
  const schema = buildMap.schema && typeof buildMap.schema === 'object' ? buildMap.schema : null;
  const steps = [
    () => {
      buildMap.tracked_files = keepRelevantFirst(buildMap.tracked_files, terms, 300); buildMap.tracked_files_truncated = true;
      // Relevance order without a cut, so what the brief names leads even when this step is enough.
      if (schema) { schema.tables = keepRelevantFirst(schema.tables, terms, 1000); schema.views = keepRelevantFirst(schema.views, terms, 1000); schema.functions = keepRelevantFirst(schema.functions, terms, 1000); }
      buildMap.supabase_edge_functions = keepRelevantFirst(buildMap.supabase_edge_functions, terms, 500);
    },
    () => {
      if (schema) { schema.tables = keepRelevantFirst(schema.tables, terms, 150); schema.views = keepRelevantFirst(schema.views, terms, 40); schema.functions = keepRelevantFirst(schema.functions, terms, 80); }
      buildMap.supabase_edge_functions = keepRelevantFirst(buildMap.supabase_edge_functions, terms, 60);
    },
    () => {
      context.relevant_files = keepRelevantFirst(context.relevant_files, terms, 60);
      if (Array.isArray(context.known_capabilities)) context.known_capabilities = context.known_capabilities.slice(0, 60);
      if (typeof context.architecture_summary === 'string') context.architecture_summary = context.architecture_summary.slice(0, 6000);
      if (typeof context.existing_design_system === 'string') context.existing_design_system = context.existing_design_system.slice(0, 6000);
    },
    () => {
      buildMap.tracked_files = keepRelevantFirst(buildMap.tracked_files, terms, 120);
      if (schema) { schema.tables = keepRelevantFirst(schema.tables, terms, 60); schema.functions = keepRelevantFirst(schema.functions, terms, 30); }
      context.live_context = null;
    },
    () => {
      buildMap.tracked_files = keepRelevantFirst(buildMap.tracked_files, terms, 40);
      if (Array.isArray(buildMap.recent_commits)) buildMap.recent_commits = buildMap.recent_commits.slice(0, 5);
      if (typeof context.architecture_summary === 'string') context.architecture_summary = context.architecture_summary.slice(0, 2500);
      if (typeof context.existing_design_system === 'string') context.existing_design_system = context.existing_design_system.slice(0, 2500);
    }
  ];
  for (const step of steps) { step(); if (size() <= maxChars) break; }
  context.context_fitted_to_chars = maxChars;
  return context;
}

function failedTestPaths(output) {
  const text = String(output || '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  return [...new Set([
    ...[...text.matchAll(/^\s*(?:FAIL|✖|✘|×)\s+([^\s:>]+)/gm)].map(match => match[1]),
    ...[...text.matchAll(/^\s*❯\s+([^\s]+)\s+\([^\r\n]*\b[1-9]\d* failed\b/gm)].map(match => match[1]),
    ...[...text.matchAll(/^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?([^\r\n]+?\.(?:spec|test)\.tsx?)(?::|\s|$)/gm)].map(match => match[1]),
  ])].filter(file => /\.(?:test|spec)\.tsx?$/i.test(file)).slice(0, 20);
}

function mainHealthEvidenceConflict(job) {
  if (job.autopilot_source !== 'main_monitor') return null;
  const task = String(job.task_description || '');
  const declared = Array.isArray(job.source_main_health_files) ? job.source_main_health_files
    : (task.match(/failing (?:guard )?tests:\s*([^\r\n]+)/i)?.[1]?.match(/(?:apps\/web\/)?(?:src|e2e)\/[\w./-]+\.(?:test|spec)\.tsx?/g) || []);
  const normalize = file => file.startsWith('apps/web/') ? file : `apps/web/${file}`;
  const observed = failedTestPaths(task).map(normalize);
  const scope = declared.map(normalize);
  const outside = observed.filter(file => !scope.includes(file));
  if (!outside.length) return null;
  return `Evidence conflict: the isolated failure receipt names ${outside.join(', ')} outside this repair's immutable scope. Recreate the repair from the pinned check receipt; do not widen scope or retry models.`;
}

module.exports = { MAX_TRACKED_FILES, MAX_SCHEMA_ENTITIES, EXCLUDED_PATH, LOW_SIGNAL_PATH, DEFAULT_CONTEXT_MAX_CHARS, boundTrackedFiles, directoryCounts, collectSchemaInventory, collectRepositoryContext, fitRepositoryContext, relevanceTerms, failedTestPaths, mainHealthEvidenceConflict };