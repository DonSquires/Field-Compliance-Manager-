// Measure Ollama CPU/GPU throughput with a reviewer-shaped prompt. Read-only; no app data.
// usage: node ollama-bench.mjs <ollama_base_url> <model>
const [base = 'http://127.0.0.1:11434', model = 'qwen2.5-coder:7b'] = process.argv.slice(2);
const prompt = [
  'You are an independent code reviewer. Review this diff for correctness and risk.',
  'Reply with JSON {"verdict":"passed"|"blocked","summary":string,"findings":[]}.',
  '',
  'diff --git a/services/fcm-api/src/bob/verify.js b/services/fcm-api/src/bob/verify.js',
  '-const BLANKET_AFFIRMATIVE_RE = /^\\s*(yes|yep|ok|go ahead|all good)[\\s.!]*$/i;',
  '+const BLANKET_AFFIRMATIVE_RE = /^\\s*(yes|yep|ok|go ahead|go for it|yes please|all good( with me)?|crack on)[\\s.!]*$/i;',
  '',
  'Context: BLANKET_AFFIRMATIVE_RE decides whether a short user reply counts as a blanket "yes" to an earlier list of questions.',
].join('\n');
const started = Date.now();
const r = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { num_predict: 220, temperature: 0 } }) });
const data = await r.json();
if (!r.ok || data.error) { console.log('error', r.status, data.error ?? JSON.stringify(data).slice(0, 200)); process.exit(1); }
const s = (ns) => (ns / 1e9).toFixed(1);
console.log(`model ${model} | prompt ${data.prompt_eval_count} tok in ${s(data.prompt_eval_duration)} s (${(data.prompt_eval_count / (data.prompt_eval_duration / 1e9)).toFixed(0)} tok/s) | generated ${data.eval_count} tok in ${s(data.eval_duration)} s (${(data.eval_count / (data.eval_duration / 1e9)).toFixed(1)} tok/s) | wall ${((Date.now() - started) / 1000).toFixed(1)} s (load ${s(data.load_duration)} s)`);
console.log('reply:', String(data.response).replace(/\s+/g, ' ').slice(0, 500));
