const fs = require('node:fs');

async function checkRuntimeIdle({ url, key, healthUrl = 'http://172.16.0.1:8091/health', fetchImpl = fetch }) {
  if (!url || !key) return { idle: false, reason: 'activity credentials unavailable' };
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const [workers, models, vibeMessages, chatMessages, health] = await Promise.all([
      fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/builder_worker_runs?select=id&status=in.(running,queued)&limit=1`, { headers, signal: AbortSignal.timeout(15000) }),
      fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/builder_model_runs?select=id&status=in.(running,queued)&limit=1`, { headers, signal: AbortSignal.timeout(15000) }),
      fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/builder_vibe_messages?select=id&status=in.(pending,claimed)&limit=1`, { headers, signal: AbortSignal.timeout(15000) }),
      fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/builder_chat_messages?select=id&status=eq.claimed&limit=1`, { headers, signal: AbortSignal.timeout(15000) }),
      fetchImpl(healthUrl, { signal: AbortSignal.timeout(30000) }),
    ]);
    if (![workers, models, vibeMessages, chatMessages, health].every(response => response.ok)) return { idle: false, reason: 'activity endpoint unavailable' };
    const [workerRows, modelRows, vibeRows, chatRows, runtime] = await Promise.all([workers.json(), models.json(), vibeMessages.json(), chatMessages.json(), health.json()]);
    if (!Array.isArray(workerRows) || !Array.isArray(modelRows) || !Array.isArray(vibeRows) || !Array.isArray(chatRows) || !Number.isInteger(runtime?.runningBuilderJobs) || runtime.runningBuilderJobs < 0) {
      return { idle: false, reason: 'activity response malformed' };
    }
    if (workerRows.length) return { idle: false, reason: 'verification worker in flight' };
    if (modelRows.length) return { idle: false, reason: 'model run in flight' };
    if (vibeRows.length) return { idle: false, reason: 'vibe turn in flight' };
    if (chatRows.length) return { idle: false, reason: 'Builder chat turn in flight' };
    if (runtime.runningBuilderJobs) return { idle: false, reason: 'runtime execution in flight' };
    // Older control planes do not report Dr Bob runs; a missing field means none are tracked.
    if (Number.isInteger(runtime.activeHumanTests) && runtime.activeHumanTests > 0) return { idle: false, reason: 'Dr Bob human test in flight' };
    return { idle: true, reason: 'no recorded worker, model or runtime execution in flight' };
  } catch {
    return { idle: false, reason: 'activity check failed' };
  }
}

async function main() {
  const config = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  if (!config.url || !config.key) {
    const content = fs.readFileSync(process.env.BOB_CONTROL_PLANE_ENV || '/var/lib/bob/control-plane.env', 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!config.url && line.startsWith('SUPABASE_URL=')) config.url = line.slice('SUPABASE_URL='.length);
      if (!config.key && line.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) config.key = line.slice('SUPABASE_SERVICE_ROLE_KEY='.length);
    }
  }
  const result = await checkRuntimeIdle(config);
  console.log(`Builder deploy ${result.idle ? 'idle' : 'deferred'}: ${result.reason}`);
  process.exitCode = result.idle ? 0 : 1;
}

if (require.main === module) main().catch(() => {
  console.error('Builder deploy deferred: activity configuration unavailable');
  process.exitCode = 1;
});

module.exports = { checkRuntimeIdle };
