import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { acceptanceCoverage } from './builderApprovalSummary';

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
  steps: Array<{ input_context?: { implementation_acceptance: { report: ProjectedReport } } }>;
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
  ]) assert.equal(acceptanceCoverage(projectReport(malformed)).supplied, false);
});
