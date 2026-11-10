'use strict';

/**
 * Auto model routing (owner direction 2026-11-10: "the right agent is selected for the job instead
 * of hard coding it"). Bob Builder, Vibe Builder and in-app Bob rank the providers/models they can
 * reach for each job from data, not from a fixed chain:
 *
 *   bob_model_catalog           what each provider/model is good at, its cost tier and privacy class
 *   bob_model_task_classes      which task class a workload, prompt family or role belongs to
 *   bob_model_routing_policies  per surface/task (platform default, optional org override): weights,
 *                               external permission, cost ceiling, candidate cap
 *   bob_model_route_stats()     observed success rate and latency from builder_model_runs
 *
 * Score = quality·w.q + smoothed success·w.s + cheapness·w.c + speed·w.l. Observed success is
 * smoothed toward the catalogue prior, so a model with few runs is neither trusted nor written off.
 * Restricted data is never offered to an external model whatever the data says; that invariant is
 * enforced here and by the callers. When the tables cannot be read the caller's static chain stands.
 */

const DEFAULT_WEIGHTS = Object.freeze({ quality: 0.3, success: 0.4, cost: 0.2, latency: 0.1 });
const DEFAULT_PRIOR_STRENGTH = 6;
const DEFAULT_MAX_CANDIDATES = 6;
const DEFAULT_MAX_PER_PROVIDER = 2;
const LOAD_TTL_MS = 60_000;
const LOAD_FAIL_TTL_MS = 30_000;
const LOAD_TIMEOUT_MS = 4_000;
const LOCAL_FALLBACK = new Set(['gpu_workstation', 'ollama', 'vps_ollama']);
const PLATFORM = '*';

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function promptFamily(promptVersion) {
  return String(promptVersion || '').replace(/-v\d+$/, '');
}

function taskClassFor(taskClasses, { workloadKind, promptVersion, role } = {}) {
  const rows = Array.isArray(taskClasses) ? taskClasses : [];
  const find = (kind, value) => value && rows.find(row => row.match_kind === kind && row.match_value === value);
  const hit = find('workload_kind', workloadKind) || find('prompt_family', promptFamily(promptVersion)) || find('role', role);
  return hit ? hit.task_class : 'general';
}

function catalogEntry(catalog, provider, model) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const exact = model ? rows.find(row => row.provider === provider && row.model_name === model) : null;
  const generic = rows.find(row => row.provider === provider && row.model_name === PLATFORM);
  if (exact) return { ...(generic || {}), ...exact, task_quality: { ...(generic?.task_quality || {}), ...(exact.task_quality || {}) } };
  if (generic) return generic;
  // An uncatalogued provider is treated as external until the owner classifies it: fail closed on privacy.
  return { provider, model_name: PLATFORM, privacy_class: LOCAL_FALLBACK.has(provider) ? 'local' : 'external', cost_tier: LOCAL_FALLBACK.has(provider) ? 0 : 2, base_quality: 0.5, task_quality: {}, active: true, uncatalogued: true };
}

function resolvePolicy(policies, { surface, taskClass, organizationId = null } = {}) {
  const rows = (Array.isArray(policies) ? policies : []).filter(row => row.active !== false);
  let best = null;
  let bestRank = -1;
  for (const row of rows) {
    if (row.organization_id && row.organization_id !== organizationId) continue;
    if (row.surface !== PLATFORM && row.surface !== surface) continue;
    if (row.task_class !== PLATFORM && row.task_class !== taskClass) continue;
    const rank = (row.organization_id ? 4 : 0) + (row.surface !== PLATFORM ? 2 : 0) + (row.task_class !== PLATFORM ? 1 : 0);
    if (rank > bestRank) { best = row; bestRank = rank; }
  }
  return best;
}

function statFor(stats, provider, model, taskClass) {
  const rows = Array.isArray(stats) ? stats : [];
  const same = row => row.provider === provider && (!model || row.model_name === model);
  const forTask = rows.filter(row => same(row) && row.task_class === taskClass);
  const pool = forTask.length ? forTask : rows.filter(same);
  if (!pool.length) return null;
  let runs = 0; let completed = 0; let seconds = 0; let timed = 0;
  for (const row of pool) {
    const count = Number(row.runs) || 0;
    runs += count;
    completed += Number(row.completed) || 0;
    if (Number.isFinite(Number(row.avg_seconds)) && count) { seconds += Number(row.avg_seconds) * count; timed += count; }
  }
  return { runs, completed, avg_seconds: timed ? seconds / timed : null, scope: forTask.length ? 'task' : 'any_task' };
}

/**
 * Order candidates ({ provider, model }) for one job. Returns { ordered, decisions, excluded, policy, task_class }.
 * `ordered` keeps only permitted candidates; `excluded` says why the rest were dropped.
 */
function rankCandidates({ candidates, catalog = [], policies = [], stats = [], taskClasses = [], surface, workloadKind = null, promptVersion = null, role = null, organizationId = null, restricted = false, observed = [] }) {
  const taskClass = taskClassFor(taskClasses, { workloadKind, promptVersion, role });
  const policy = resolvePolicy(policies, { surface, taskClass, organizationId });
  const weights = { ...DEFAULT_WEIGHTS, ...(policy?.weights && typeof policy.weights === 'object' ? policy.weights : {}) };
  const priorStrength = Number(policy?.prior_strength) > 0 ? Number(policy.prior_strength) : DEFAULT_PRIOR_STRENGTH;
  const maxCostTier = Number.isFinite(Number(policy?.max_cost_tier)) ? Number(policy.max_cost_tier) : 3;
  const allowExternal = policy ? policy.allow_external !== false : true;
  const excludedProviders = new Set(Array.isArray(policy?.excluded_providers) ? policy.excluded_providers : []);
  const allStats = [...(Array.isArray(stats) ? stats : []), ...(Array.isArray(observed) ? observed : [])];
  const scored = [];
  const excluded = [];
  (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
    const entry = catalogEntry(catalog, candidate.provider, candidate.model);
    const external = entry.privacy_class !== 'local';
    const drop = reason => excluded.push({ provider: candidate.provider, model: candidate.model || null, reason });
    if (restricted && external) return drop('restricted_data_local_only');
    if (entry.active === false) return drop('catalog_inactive');
    if (excludedProviders.has(candidate.provider)) return drop('policy_excluded');
    if (external && !allowExternal) return drop('policy_local_only');
    if (Number(entry.cost_tier) > maxCostTier) return drop('policy_cost_ceiling');
    const quality = clamp01(entry.task_quality?.[taskClass], clamp01(entry.base_quality, 0.5));
    const stat = statFor(allStats, candidate.provider, candidate.model, taskClass);
    // Untried models start halfway between neutral and their catalogue quality: a premium model must
    // earn its rank with real outcomes rather than lead on its reputation alone.
    const prior = 0.5 + (quality - 0.5) * 0.5;
    // A model with little history inherits its provider's record on this task, so a provider that keeps
    // failing a task cannot have each of its other models re-tried on a fresh optimistic prior.
    const providerStat = candidate.model ? statFor(allStats, candidate.provider, null, taskClass) : null;
    const providerPrior = providerStat ? (providerStat.completed + prior * priorStrength) / (providerStat.runs + priorStrength) : prior;
    const success = stat ? (stat.completed + providerPrior * priorStrength) / (stat.runs + priorStrength) : providerPrior;
    const speed = stat && stat.avg_seconds !== null ? 1 / (1 + stat.avg_seconds / 120) : 0.5;
    const cheapness = 1 - clamp01(Number(entry.cost_tier) / 3, 0.66);
    const score = weights.quality * quality + weights.success * success + weights.cost * cheapness + weights.latency * speed;
    scored.push({
      ...candidate,
      index,
      score: Math.round(score * 1000) / 1000,
      quality: Math.round(quality * 1000) / 1000,
      success: Math.round(success * 1000) / 1000,
      runs: stat ? stat.runs : 0,
      cost_tier: Number(entry.cost_tier),
      privacy_class: external ? 'external' : 'local',
    });
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const cap = Number(policy?.max_candidates) > 0 ? Number(policy.max_candidates) : DEFAULT_MAX_CANDIDATES;
  // One provider's model list must not fill every slot: its extra models only take slots other providers leave free.
  const perProvider = Number(policy?.max_per_provider) > 0 ? Number(policy.max_per_provider) : DEFAULT_MAX_PER_PROVIDER;
  const counts = new Map();
  const first = [];
  const overflow = [];
  for (const candidate of scored) {
    const count = counts.get(candidate.provider) || 0;
    (count < perProvider ? first : overflow).push(candidate);
    counts.set(candidate.provider, count + 1);
  }
  const ordered = [...first, ...overflow].slice(0, cap);
  return {
    ordered: ordered.map(({ index, ...rest }) => rest),
    excluded,
    task_class: taskClass,
    policy: policy ? { id: policy.id || null, surface: policy.surface, task_class: policy.task_class, organization_id: policy.organization_id || null } : null,
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model routing data timed out')), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * A cached loader over the routing tables plus an in-process outcome tally (`observe`), so a model
 * failing right now loses rank before the next stats refresh. Without a client, `rank` returns null
 * and callers keep their static chain.
 */
function createModelRouter({ supabase = null, now = Date.now, logger = console, ttlMs = LOAD_TTL_MS } = {}) {
  let cache = null;
  let cacheUntil = 0;
  let inflight = null;
  const tally = new Map();

  async function load() {
    if (!supabase || typeof supabase.from !== 'function') return null;
    if (cache && cacheUntil > now()) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const [catalog, policies, taskClasses, stats] = await withTimeout(Promise.all([
          supabase.from('bob_model_catalog').select('provider, model_name, privacy_class, cost_tier, base_quality, task_quality, active'),
          // '*' so a policy column added later (e.g. max_per_provider) never breaks a router deployed first.
          supabase.from('bob_model_routing_policies').select('*'),
          supabase.from('bob_model_task_classes').select('match_kind, match_value, task_class'),
          supabase.rpc('bob_model_route_stats', { p_days: 30 }),
        ]), LOAD_TIMEOUT_MS);
        const failed = [catalog, policies, taskClasses].find(result => result.error);
        if (failed) throw new Error(failed.error.message || 'routing tables unavailable');
        cache = {
          catalog: catalog.data || [],
          policies: policies.data || [],
          taskClasses: taskClasses.data || [],
          stats: stats.error ? [] : (stats.data || []),
        };
        cacheUntil = now() + ttlMs;
        return cache;
      } catch (error) {
        logger.warn?.(`model router: routing data unavailable, static chains stand (${String(error && error.message || error).slice(0, 160)})`);
        cacheUntil = now() + LOAD_FAIL_TTL_MS;
        cache = cache && cache.catalog.length ? cache : null;
        return cache;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function observe({ provider, model = null, taskClass = 'general', ok, latencyMs = null }) {
    if (!provider) return;
    const key = `${provider}\u0000${model || ''}\u0000${taskClass}`;
    const row = tally.get(key) || { provider, model_name: model, task_class: taskClass, runs: 0, completed: 0, total_seconds: 0, timed: 0 };
    row.runs += 1;
    if (ok) row.completed += 1;
    if (Number.isFinite(Number(latencyMs))) { row.total_seconds += Number(latencyMs) / 1000; row.timed += 1; }
    tally.set(key, row);
  }

  function observed() {
    return [...tally.values()].map(row => ({ provider: row.provider, model_name: row.model_name, task_class: row.task_class, runs: row.runs, completed: row.completed, avg_seconds: row.timed ? row.total_seconds / row.timed : null }));
  }

  async function rank(request) {
    const data = await load();
    if (!data || !data.catalog.length) return null;
    return rankCandidates({ ...request, ...data, observed: observed() });
  }

  async function taskClass(request) {
    const data = await load();
    return taskClassFor(data ? data.taskClasses : [], request);
  }

  async function catalogProviders() {
    const data = await load();
    if (!data) return [];
    return [...new Set(data.catalog.filter(row => row.active !== false).map(row => row.provider))];
  }

  return { rank, observe, taskClass, catalogProviders, load };
}

let defaultRouter = null;
function setDefaultModelRouter(router) { defaultRouter = router || null; }
function getDefaultModelRouter() { return defaultRouter; }

module.exports = {
  DEFAULT_WEIGHTS,
  createModelRouter,
  rankCandidates,
  resolvePolicy,
  taskClassFor,
  catalogEntry,
  promptFamily,
  setDefaultModelRouter,
  getDefaultModelRouter,
};
