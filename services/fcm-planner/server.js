const http = require('node:http');

const port = Number(process.env.PORT || 3004);
const pollIntervalMs = Number(process.env.PLANNER_POLL_INTERVAL_MS || 15_000);
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let lastRun = null;
let lastError = null;
let running = false;

function configured() {
  return Boolean(supabaseUrl && serviceRoleKey);
}

async function advanceOneReadyStep() {
  if (!configured() || running) return;
  running = true;
  try {
    const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
    const steps = await fetch(`${supabaseUrl}/rest/v1/bob_job_plan_steps?select=id&status=eq.ready&order=updated_at.asc&limit=1`, { headers });
    if (!steps.ok) throw new Error(`step lookup returned ${steps.status}`);
    const [step] = await steps.json();
    if (!step) return;
    const response = await fetch(`${supabaseUrl}/functions/v1/bob-plan-step-advance`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ step_id: step.id })
    });
    if (!response.ok) throw new Error(`step advance returned ${response.status}`);
    lastRun = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error(`[fcm-planner] ${lastError}`);
  } finally {
    running = false;
  }
}

http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'fcm-planner', configured: configured(), lastRun, lastError }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
}).listen(port, '0.0.0.0', () => {
  console.log(`[fcm-planner] listening on ${port}`);
  void advanceOneReadyStep();
  setInterval(() => void advanceOneReadyStep(), pollIntervalMs).unref();
});