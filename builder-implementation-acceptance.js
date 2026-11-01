'use strict';

const { downloadVerifiedArtifact } = require('./builder-artifact-read');
const { unwrapPatchArtifact } = require('./supabase/functions/_shared/builder-patch-envelope');

const IMPLEMENTATION_STEPS = ['frontend_implementation', 'backend_implementation'];
const EVIDENCE_TYPES = ['product_specification', 'code_implementation', 'changed_file_manifest', 'build_logs'];

function testCommandCovers(file, run) {
  if (run.status !== 0 || run.timed_out || run.error) return false;
  const command = String(run.command || '');
  const tokens = command.split(/\s+/);
  if (tokens[0] === 'node' && tokens.includes('--test')) {
    return tokens.includes(file) || (file.startsWith('test/') && tokens.includes('test/*.test.js'))
      || tokens.at(-1) === '--test';
  }
  if (!command.startsWith('npm run test') || !command.includes('--prefix apps/web') || !file.startsWith('apps/web/')) return false;
  const browser = command.startsWith('npm run test:e2e ');
  if (browser !== file.startsWith('apps/web/e2e/')) return false;
  const selectors = tokens.filter(token => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(token));
  return selectors.length ? selectors.includes(file.slice('apps/web/'.length)) : !browser;
}

function acceptanceIdentity(snapshot) {
  const steps = snapshot.steps.filter(step => IMPLEMENTATION_STEPS.includes(step.step_id));
  const stepIds = new Set(steps.map(step => step.id));
  return {
    target_sha: snapshot.job.target_sha,
    correction: snapshot.job.code_review_revision ?? null,
    steps: steps.map(({ id, step_id, status }) => ({ id, step_id, status })).sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: snapshot.artifacts.filter(artifact => artifact.status === 'final'
      && EVIDENCE_TYPES.includes(artifact.artifact_type)
      && (stepIds.has(artifact.step_id) || artifact.artifact_type === 'product_specification'))
      .map(({ id, step_id, artifact_type, checksum }) => ({ id, step_id, artifact_type, checksum }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    runs: snapshot.workerRuns.filter(run => stepIds.has(run.step_id) && run.status === 'completed'
      && ['frontend-verify', 'backend-verify'].includes(run.profile)
      && snapshot.artifacts.some(artifact => artifact.id === run.patch_artifact_id && artifact.status === 'final'))
      .map(({ id, step_id, patch_artifact_id, output_artifact_ids }) => ({
        id, step_id, patch_artifact_id, output_artifact_ids: [...(output_artifact_ids || [])].sort()
      })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function reconcileAcceptance(specification, bundles) {
  const blockers = [];
  const requirements = specification?.delivery_requirements;
  const rows = [];
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > 100) {
    blockers.push('The current specification needs 1-100 mandatory delivery requirements before acceptance can be reconciled.');
  } else {
    const ids = new Set();
    for (const requirement of requirements) {
      const id = typeof requirement?.id === 'string' ? requirement.id.trim() : '';
      const gaps = [];
      if (!id || ids.has(id)) gaps.push('Requirement identity is missing or duplicated in the specification.');
      ids.add(id);
      const scope = Array.isArray(requirement?.source_scope) ? requirement.source_scope : [];
      if (!scope.length || scope.some(file => typeof file !== 'string' || !file.trim())) gaps.push('Approved source scope is missing.');
      const claims = bundles.flatMap(bundle => (Array.isArray(bundle.envelope?.acceptance_evidence) ? bundle.envelope.acceptance_evidence : [])
        .filter(entry => entry.requirement_id === id).map(entry => ({ ...entry, bundle })));
      if (!claims.length) gaps.push('No current verified implementation claims this mandatory outcome; a skipped lane does not waive it.');
      for (const claim of claims) {
        const files = claim.bundle.manifest.map(item => item.path);
        if (claim.status !== 'completed' || typeof claim.evidence !== 'string' || !claim.evidence.trim()) {
          gaps.push('The current implementation does not supply completed acceptance evidence.');
          continue;
        }
        if (!files.some(file => scope.includes(file) && claim.evidence.includes(file))) {
          gaps.push('Evidence must name an actual changed file in the approved scope; a lane reroute cannot silently rewrite that scope.');
        }
        const testFiles = files.filter(file => /(?:^test\/.*\.test\.[cm]?js$|[./][^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(file));
        const regressionRequired = /\b(?:tests?|testing|coverage|regression|synthetic|scenarios?|playwright)\b/i.test(String(requirement.evidence || ''));
        if (regressionRequired && !testFiles.some(file => claim.evidence.includes(file))) {
          gaps.push('Evidence must identify a changed regression test for this outcome, not only an implementation file.');
        }
        const commands = claim.bundle.verification.commands ?? claim.bundle.verification.checks;
        if (regressionRequired && !testFiles.some(file => claim.evidence.includes(file)
          && Array.isArray(commands) && commands.some(command => testCommandCovers(file, command)))) {
          gaps.push('The independent worker has no passing command covering the named regression test for this outcome.');
        }
      }
      rows.push({ requirement_id: id, outcome: String(requirement?.outcome || ''),
        required_evidence: requirement?.evidence, source_scope: scope,
        evidence: claims.map(({ requirement_id, status, evidence, bundle }) => ({ requirement_id, status, evidence, patch_artifact_id: bundle.patchId })),
        status: gaps.length ? 'blocked' : 'covered', gaps: [...new Set(gaps)],
        patch_artifact_ids: [...new Set(claims.map(claim => claim.bundle.patchId))] });
      blockers.push(...[...new Set(gaps)].map(gap => `${id || '(missing id)'}: ${gap}`));
    }
    for (const bundle of bundles) {
      const claims = bundle.envelope?.acceptance_evidence;
      if (!Array.isArray(claims)) {
        blockers.push(`Patch ${bundle.patchId} has no structured acceptance evidence; raw or retained-seed patches are not acceptance proof.`);
        continue;
      }
      const seen = new Set();
      for (const entry of claims) {
        if (!ids.has(entry.requirement_id) || seen.has(entry.requirement_id)) {
          blockers.push(`Patch ${bundle.patchId} has an unknown or duplicated acceptance requirement: ${String(entry.requirement_id).slice(0, 100)}.`);
        }
        seen.add(entry.requirement_id);
      }
    }
  }
  return { version: 1, passed: blockers.length === 0, requirements: rows, blockers,
    workflow_verification: specification?.workflow_verification,
    acceptance_criteria: specification?.acceptance_criteria,
    limitation: 'Coverage reconciliation is not semantic or human acceptance. Review must compare the actual patch and tests with each full outcome and correction feedback.' };
}

async function checkImplementationAcceptance({ supabase, snapshot, loadArtifact = downloadVerifiedArtifact }) {
  const identity = acceptanceIdentity(snapshot);
  const specifications = snapshot.artifacts.filter(artifact => artifact.artifact_type === 'product_specification' && artifact.status === 'final');
  const bundles = [];
  const evidenceErrors = [];
  for (const name of IMPLEMENTATION_STEPS) {
    if (snapshot.steps.filter(step => step.step_id === name).length !== 1) evidenceErrors.push(`Implementation lane state is missing or ambiguous: ${name}.`);
  }
  let specification = null;
  if (specifications.length !== 1) {
    evidenceErrors.push('Exactly one current approved product specification is required.');
  } else {
    const { bytes } = await loadArtifact(supabase, specifications[0].id, snapshot.job.id, 'product_specification');
    specification = JSON.parse(bytes.toString('utf8'));
  }
  for (const step of snapshot.steps.filter(item => IMPLEMENTATION_STEPS.includes(item.step_id))) {
    if (step.status === 'skipped') continue;
    if (step.status !== 'completed') {
      evidenceErrors.push(`${step.step_id} has not completed independent verification.`);
      continue;
    }
    const runs = identity.runs.filter(run => run.step_id === step.id);
    if (runs.length !== 1) {
      evidenceErrors.push(`${step.step_id} needs exactly one current verified artifact set.`);
      continue;
    }
    const run = runs[0];
    const worker = snapshot.workerRuns.find(item => item.id === run.id);
    const patchArtifact = snapshot.artifacts.find(item => item.id === run.patch_artifact_id);
    if (worker.target_sha !== snapshot.job.target_sha || worker.organization_id !== snapshot.job.organization_id
      || worker.profile !== (step.step_id === 'frontend_implementation' ? 'frontend-verify' : 'backend-verify')
      || patchArtifact?.step_id !== step.id || patchArtifact.artifact_type !== 'code_implementation') {
      evidenceErrors.push(`${step.step_id} worker or patch provenance does not match the current job, target and lane.`);
      continue;
    }
    const outputs = snapshot.artifacts.filter(artifact => run.output_artifact_ids.includes(artifact.id)
      && artifact.step_id === step.id && artifact.status === 'final');
    const manifest = outputs.filter(artifact => artifact.artifact_type === 'changed_file_manifest');
    const logs = outputs.filter(artifact => artifact.artifact_type === 'build_logs');
    if (manifest.length !== 1 || logs.length !== 1) {
      evidenceErrors.push(`${step.step_id} is missing its current worker manifest or build log.`);
      continue;
    }
    const [patchData, manifestData, logData] = await Promise.all([
      loadArtifact(supabase, run.patch_artifact_id, snapshot.job.id, 'code_implementation'),
      loadArtifact(supabase, manifest[0].id, snapshot.job.id, 'changed_file_manifest'),
      loadArtifact(supabase, logs[0].id, snapshot.job.id, 'build_logs')
    ]);
    const { envelope } = unwrapPatchArtifact(patchData.bytes);
    const changedFiles = JSON.parse(manifestData.bytes.toString('utf8'));
    const verification = JSON.parse(logData.bytes.toString('utf8'));
    if (!Array.isArray(changedFiles) || !changedFiles.length || changedFiles.some(item => typeof item?.path !== 'string')
      || verification?.succeeded !== true) {
      evidenceErrors.push(`${step.step_id} has malformed or unsuccessful independent verification evidence.`);
      continue;
    }
    bundles.push({ patchId: run.patch_artifact_id, envelope, manifest: changedFiles, verification });
  }
  if (!bundles.length) evidenceErrors.push('No current independently verified implementation is available.');
  const report = reconcileAcceptance(specification, bundles);
  report.blockers.unshift(...evidenceErrors);
  report.passed = report.blockers.length === 0;
  const { error } = await supabase.rpc('builder_record_implementation_acceptance', {
    _job_id: snapshot.job.id, _expected_identity: identity, _report: report
  });
  if (error) throw new Error(`Implementation acceptance could not be recorded: ${error.message}`);
  return report;
}

module.exports = { acceptanceIdentity, reconcileAcceptance, checkImplementationAcceptance, testCommandCovers };
