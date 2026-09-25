const baseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

let rows = 0;
let beforeBytes = 0;
let afterBytes = 0;
for (;;) {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/compact_cctv_inference_results`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_limit: 5 }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`result compaction failed (${response.status}): ${result?.message ?? 'unknown error'}`);
  if (!result?.rows) break;
  rows += Number(result.rows);
  beforeBytes += Number(result.before_bytes) || 0;
  afterBytes += Number(result.after_bytes) || 0;
  console.log(`CCTV inference results compacted: ${rows}`);
}
console.log(`CCTV inference result compaction complete: ${rows} rows; ${Math.round(beforeBytes / 1024 / 1024)} MB -> ${Math.round(afterBytes / 1024 / 1024)} MB`);