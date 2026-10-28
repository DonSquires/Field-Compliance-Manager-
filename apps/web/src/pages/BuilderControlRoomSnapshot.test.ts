import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { acceptanceCoverage } from '../lib/builderApprovalSummary';
import { failedFrontendPatchRetryCandidate } from './BuilderControlRoomPage';

vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, rpc: vi.fn() } }));
vi.mock('../components/BuilderChatPanel', () => ({ BuilderChatPanel: () => null }));
vi.mock('../components/ChangeRequestQueue', () => ({ ChangeRequestQueue: () => null }));

const source = fs.readFileSync(path.resolve(process.cwd(), '../../supabase/functions/bob-builder-control-room/index.ts'), 'utf8');
const projection = source.slice(source.indexOf('function acceptanceSummary('), source.indexOf('async function relay('));
const compiled = ts.transpileModule(`${projection}\nthis.project = safeSnapshot;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length, 0);
interface ProjectedReport {
  version: number;
  passed: boolean;
  blockers: string[];
  requirements: Array<{ requirement_id: string | null; status: string }>;
}
interface ProjectedSnapshot {
  steps: Array<{
    step_id?: string;
    input_context?: { implementation_acceptance: { report: ProjectedReport } } & Partial<Record<'patch_artifact_id' | 'target_sha', string>>;
  }>;
}
const context = { safeJob: (value: unknown) => value,
  strings: (value: unknown, max: number) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, max) : [],
  project: (_input: unknown): ProjectedSnapshot => { throw new Error('Projection was not loaded'); } };
vm.createContext(context);
vm.runInContext(compiled.outputText, context);
const project = (input: unknown): ReturnType<typeof context.project> => JSON.parse(JSON.stringify(context.project(input)));

test('actual control-room projection carries bounded acceptance blockers but excludes private execution context', () => {
  const input = {
    unrelated: 'private prompt',
    implementation_acceptance: { identity: { correction: { feedback: 'private correction' } },
      report: { version: 1, passed: false,
        blockers: ['DR-1: actual workflow absent'],
        requirements: [{ requirement_id: 'DR-1', status: 'blocked', evidence: 'private source and author packet' }],
        workflow_verification: 'private workflow source' } }
  };
  const result = project({ steps: [
    { id: 'test', step_id: 'test_suite', input_context: input },
    { id: 'author', step_id: 'frontend_implementation', input_context: input }
  ] });
  assert.deepEqual(result.steps[0].input_context, { implementation_acceptance: { report: {
    version: 1, passed: false, blockers: ['DR-1: actual workflow absent'],
    requirements: [{ requirement_id: 'DR-1', status: 'blocked' }]
  } } });
  assert.equal(result.steps[1].input_context, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private|identity|workflow_verification|unrelated/);
  assert.deepEqual(acceptanceCoverage(result.steps[0].input_context), {
    supplied: false, blockers: ['DR-1: actual workflow absent'],
  });
});

test('actual projection preserves covered status, rejects malformed receipts and bounds output', () => {
  const projectReport = (report: unknown) => project({ steps: [{ step_id: 'test_suite',
    input_context: { implementation_acceptance: { report } } }] }).steps[0].input_context;
  const report = { version: 1, passed: true, blockers: [], requirements: [{ requirement_id: 'DR-1', status: 'covered' }] };
  assert.deepEqual(projectReport(report)?.implementation_acceptance.report, report);
  assert.equal(acceptanceCoverage(projectReport(report)).supplied, true);
  assert.equal(projectReport({ passed: true }), undefined);
  assert.equal(projectReport({ ...report, blockers: 'bad' }), undefined);
  const large = projectReport({ ...report, passed: false, blockers: Array(400).fill('x'.repeat(2000)),
    requirements: Array(200).fill({ requirement_id: 'x'.repeat(200), status: 'invented' }) })?.implementation_acceptance.report;
  assert.ok(large);
  assert.equal(large.blockers.length, 300);
  assert.equal(large.blockers[0].length, 1000);
  assert.equal(large.requirements.length, 100);
  assert.equal(large.requirements[0].requirement_id?.length, 100);
  assert.equal(large.requirements[0].status, 'blocked');
  for (const malformed of [
    { ...report, requirements: [...Array(100).fill(report.requirements[0]), { status: 'blocked' }] },
    { ...report, requirements: [] },
    { ...report, blockers: [null] },
    { ...report, requirements: [{ status: 'invented' }] },
    { ...report, requirements: [{ status: 'covered' }] },
    { ...report, requirements: [{ requirement_id: '   ', status: 'covered' }] },
    { ...report, requirements: [{ requirement_id: 7, status: 'covered' }] },
    { ...report, requirements: [report.requirements[0], report.requirements[0]] },
    { ...report, requirements: [{ requirement_id: 'x'.repeat(101), status: 'covered' }] },
    { ...report, requirements: [{ requirement_id: `${'x'.repeat(100)}a`, status: 'covered' },
      { requirement_id: `${'x'.repeat(100)}b`, status: 'covered' }] },
  ]) {
    const projected = projectReport(malformed);
    assert.equal(projected?.implementation_acceptance.report.passed ?? false, false);
    assert.equal(acceptanceCoverage(projected).supplied, false);
  }
});

test('actual projection supplies the saved-patch retry identifiers the Control Room needs and nothing else', () => {
  const target = 'a'.repeat(40);
  const patchId = '11111111-2222-4333-8444-555555555555';
  const job = {
    id: 'failed-job', status: 'failed', target_sha: target, updated_at: '2026-10-27T11:19:32.127197+13:00',
    autopilot_requested_by: 'owner', frontend_required: true, backend_required: false, code_review_mode: 'human',
    workspace_published_at: null, workspace_published_head_sha: null,
    workspace_pull_request_url: null, workspace_pull_request_head_sha: null,
  };
  const step = (id: string, step_id: string, status: string, builder_mode: string, extra = {}) => ({
    id, step_id, status, builder_mode, retryable: false, started_at: null, completed_at: null, error: null, ...extra,
  });
  const raw = {
    job,
    steps: [
      step('analysis', 'product_analysis', 'completed', 'product_analyst'),
      step('design', 'ui_design', 'completed', 'ux_designer'),
      step('frontend-step', 'frontend_implementation', 'failed', 'frontend_engineer', {
        error: 'Verifier recovery paused after two infrastructure or attribution failures; patch preserved; inspect evidence',
        input_context: { target_sha: target, patch_artifact_id: patchId, author_prompt: 'private prompt', repair_feedback: 'private log' },
      }),
      step('backend-step', 'backend_implementation', 'skipped', 'backend_engineer'),
      ...['test_suite', 'security_review', 'code_review', 'release_prep'].map(id => step(id, id, 'pending', 'qa_security_reviewer')),
    ],
    artifacts: [{ id: patchId, step_id: 'frontend-step', artifact_type: 'code_implementation', status: 'final',
      checksum: 'b'.repeat(64), storage_location: 'private/bucket/path' }],
    workerRuns: [{ id: 'failed-run', step_id: 'frontend-step', profile: 'frontend-verify', status: 'failed',
      target_sha: target, patch_artifact_id: patchId, exit_code: 1, idempotency_key: 'private-key', lease_token: 'private-token' }],
    modelRuns: [],
    approvals: [],
    events: [],
  };
  const projected = project(raw) as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0];
  const candidate = failedFrontendPatchRetryCandidate(projected);
  assert.equal(candidate?.patch.id, patchId);
  assert.equal(candidate?.step.id, 'frontend-step');
  assert.deepEqual(projected?.steps.find(item => item.step_id === 'frontend_implementation')?.input_context,
    { patch_artifact_id: patchId, target_sha: target });
  assert.doesNotMatch(JSON.stringify(projected), /private/);

  for (const input_context of [
    { target_sha: target, patch_artifact_id: 'not-a-uuid' },
    { target_sha: 'main', patch_artifact_id: patchId },
    { patch_artifact_id: patchId },
  ]) {
    const malformed = project({ ...raw, steps: raw.steps.map(item => item.id === 'frontend-step' ? { ...item, input_context } : item) });
    assert.equal(malformed.steps.find(item => item.step_id === 'frontend_implementation')?.input_context, undefined);
    assert.equal(failedFrontendPatchRetryCandidate(malformed as unknown as Parameters<typeof failedFrontendPatchRetryCandidate>[0]), null);
  }
});
