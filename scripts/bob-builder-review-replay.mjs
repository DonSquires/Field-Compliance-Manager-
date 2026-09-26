// One-off diagnostic: replay the independent code review prompt for a job against the VPS
// model gateway and print the raw reviewer output plus the validator's verdict. Read-only.
// Usage (on the VPS, inside the control plane container or with its env):
//   node scripts/bob-builder-review-replay.mjs <job_id> [reviewer_model]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolve from the repo root like the control plane does (ESM resolution from scripts/ misses the CJS package).
const { createClient } = createRequire(new URL('../bob-control-plane-server.js', import.meta.url))('@supabase/supabase-js');
const review = require('../supabase/functions/_shared/builder-independent-code-review');
const adapter = require('../supabase/functions/_shared/builder-model-adapter');
const coordinator = require('../builder-runtime-coordinator');

const [jobId, reviewerModel = process.env.BOB_BUILDER_REVIEWER_MODEL || 'gpt-5.4-mini'] = process.argv.slice(2);
if (!jobId) { console.error('job id required'); process.exit(2); }
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const snapshot = await coordinator.loadBuilderRuntimeSnapshot(supabase, jobId);
const implementation = coordinator.implementationArtifacts(snapshot);
const securityStep = snapshot.steps.find((step) => step.step_id === 'security_review');
const security = snapshot.artifacts.filter((a) => a.step_id === securityStep?.id && a.artifact_type === 'security_review' && a.status === 'final').at(-1);
const evidence = await review.loadCodeReviewEvidence({ supabase, job: snapshot.job, artifacts: { ...implementation, security } });
const modelRequest = adapter.buildModelRunRequest({
  organizationId: snapshot.job.organization_id, jobId, stepId: snapshot.steps.find((s) => s.step_id === 'code_review').id,
  builderMode: 'code_reviewer', workloadKind: 'independent_code_review', promptVersion: `${review.INDEPENDENT_CODE_REVIEW_PROMPT_VERSION}-replay`,
  modelName: reviewerModel,
  systemPrompt: 'You are an independent coding AI reviewer for Field Compliance Manager. Review correctness, regressions, tenant isolation, authorization assumptions, data exposure, and missing tests. You can recommend passed or blocked. You have no approval, merge, deployment, or code-modification authority. Use only the verified patch, manifest, build logs, and security report. Return JSON only.',
  userPrompt: JSON.stringify(evidence), inputArtifactIds: [], outputSchema: { type: 'object', required: ['verdict', 'summary', 'findings', 'test_gaps', 'residual_risks'] },
});
modelRequest.idempotency_key = `${modelRequest.idempotency_key}::replay-${Date.now()}`;
const result = await adapter.callModelGateway({ gatewayUrl: process.env.BOB_MODEL_GATEWAY_URL || 'http://127.0.0.1:8080', apiToken: process.env.BOB_MODEL_GATEWAY_TOKEN, modelRequest });
console.log('gateway ok:', result.ok, 'status:', result.status, 'model:', result.data?.model, 'error:', result.error ?? null);
console.log('--- raw output ---');
console.log(String(result.data?.content ?? '').slice(0, 4000));
console.log('--- validator ---');
try { const parsed = review.parseIndependentCodeReview(result.data?.content); console.log('valid; verdict', parsed.verdict, 'findings', parsed.findings.length); }
catch (error) { console.log('INVALID:', error.message); }
