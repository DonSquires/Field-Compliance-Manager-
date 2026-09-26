// Probe which OpenAI models the account can use for Bob's outsourced tier and which
// parameters they accept (reasoning_effort values, JSON mode). Tiny requests, read-only.
// usage: OPENAI_API_KEY=... node scripts/bob-gpu-link/openai-probe.mjs gpt-6-sol gpt-5.6-sol ...
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error('OPENAI_API_KEY required'); process.exit(2); }
const models = process.argv.slice(2);
const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

async function attempt(model, effort) {
  const body = { model, messages: [{ role: 'system', content: 'Reply with JSON only.' }, { role: 'user', content: 'Return {"ok":true,"model":"<your model name>"}' }], response_format: { type: 'json_object' }, max_completion_tokens: 400 };
  if (effort) body.reasoning_effort = effort;
  const started = Date.now();
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }).catch((error) => ({ ok: false, status: 0, text: async () => String(error.message) }));
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  const content = data?.choices?.[0]?.message?.content ?? null;
  const err = data?.error?.message ? data.error.message.slice(0, 140) : (r.ok ? null : text.slice(0, 140));
  return { status: r.status, ms: Date.now() - started, content: content ? content.replace(/\s+/g, ' ').slice(0, 60) : null, usage: data?.usage ? { in: data.usage.prompt_tokens, out: data.usage.completion_tokens, reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? null } : null, err };
}

for (const model of models) {
  const high = await attempt(model, 'high');
  console.log(`${model} | effort=high -> ${high.status} ${high.ms}ms ${high.err ? `ERR ${high.err}` : `ok ${JSON.stringify(high.usage)} ${high.content}`}`);
  if (high.status === 200) {
    for (const effort of ['xhigh', 'max']) {
      const r = await attempt(model, effort);
      console.log(`  effort=${effort} -> ${r.status} ${r.err ? `ERR ${r.err}` : `ok ${JSON.stringify(r.usage)}`}`);
    }
  }
}
