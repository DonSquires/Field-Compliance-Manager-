const fs = require('node:fs/promises');
const path = require('node:path');
const { createAssessment } = require('./assessment-manifest');

function workerMemory(profile) {
  if (profile === 'build' || profile === 'lint') {
    return process.env.BOB_TYPESCRIPT_WORKER_MEMORY || '2g';
  }
  return process.env.BOB_WORKER_MEMORY || '1g';
}

function buildSelfHostedPlan(assessment, requestedProfiles = ['assessment', 'test', 'build', 'lint', 'security-review', 'playwright-visual-check']) {
  const defaultProfiles = ['assessment', 'test', 'build', 'lint', 'security-review', 'playwright-visual-check'];
  const profiles = Array.isArray(requestedProfiles) && requestedProfiles.length
    ? requestedProfiles.filter(profile => typeof profile === 'string' && profile.trim())
    : defaultProfiles;
  return {
    mode: 'self_hosted_bob',
    readOnly: true,
    profiles,
    summary: 'Self-hosted Bob performs evidence-based repository assessment, app validation, and browser-level visual checks before any approval.',
    steps: profiles.map((profile, index) => ({
      index,
      type: 'verification',
      profile,
      status: 'pending',
      description: `Run ${profile} in a controlled isolated environment before allowing a change to progress.`
    }))
  };
}

async function runSelfHostedBuildLoop({
  rootDir,
  artifactDir,
  profiles,
  workerImage,
  execute,
  assessmentFactory = createAssessment,
  maxRetries = 1,
  appUrl = process.env.BOB_APP_URL || process.env.VITE_APP_URL || null,
  appUrls = []
}) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const resolvedArtifacts = path.resolve(artifactDir || path.join(resolvedRoot, 'bob-artifacts'));
  const defaultProfiles = ['assessment', 'test', 'build', 'lint', 'security-review', 'playwright-visual-check'];
  const selectedProfiles = Array.isArray(profiles) && profiles.length ? profiles : defaultProfiles;
  const targetAppUrls = Array.isArray(appUrls) && appUrls.length ? appUrls : (appUrl ? [appUrl] : []);
  const assessment = assessmentFactory(resolvedRoot);
  const plan = buildSelfHostedPlan(assessment, selectedProfiles);
  const steps = [];

  await fs.mkdir(resolvedArtifacts, { recursive: true });

  for (const profile of selectedProfiles) {
    if (profile === 'playwright-visual-check' && targetAppUrls.length > 0) {
      for (const browserCheckUrl of targetAppUrls) {
        let attempt = 0;
        let outcome;
        while (attempt <= maxRetries) {
          outcome = await (execute || (async () => ({ status: 'succeeded', exitCode: 0, profile, stdout: 'ok', stderr: '' })))({
            image: workerImage || 'fcm/bob-worker:local',
            sourceDir: resolvedRoot,
            artifactDir: resolvedArtifacts,
            profile,
            timeoutMs: Number(process.env.BOB_WORKER_TIMEOUT_MS || 10 * 60 * 1000),
            memory: workerMemory(profile),
            cpus: process.env.BOB_WORKER_CPUS || '1',
            pidsLimit: Number(process.env.BOB_WORKER_PIDS_LIMIT || 128),
            browserCheck: true,
            appUrl: browserCheckUrl,
            env: { BOB_APP_URL: browserCheckUrl }
          });

          if (outcome?.status === 'failed' || outcome?.exitCode !== 0) {
            attempt += 1;
            if (attempt <= maxRetries) {
              continue;
            }
          }
          break;
        }

        const terminalStatus = outcome?.status === 'failed' || outcome?.exitCode !== 0 ? 'failed' : 'succeeded';
        steps.push({
          profile: `${profile}:${browserCheckUrl}`,
          status: terminalStatus,
          exitCode: outcome?.exitCode ?? 0,
          stdout: outcome?.stdout || '',
          stderr: outcome?.stderr || '',
          artifactDir: resolvedArtifacts,
          appUrl: browserCheckUrl,
          requestedBy: 'self_hosted_bob',
          retriesUsed: Math.max(0, Number(outcome?.retriesUsed ?? 0))
        });

        if (terminalStatus === 'failed') {
          return {
            mode: 'self_hosted_bob',
            readOnly: true,
            assessment,
            plan,
            steps,
            paused: true,
            reason: `verification_failed:${profile}:${browserCheckUrl}`
          };
        }
      }
    } else {
      let attempt = 0;
      let outcome;
      while (attempt <= maxRetries) {
        outcome = await (execute || (async () => ({ status: 'succeeded', exitCode: 0, profile, stdout: 'ok', stderr: '' })))({
          image: workerImage || 'fcm/bob-worker:local',
          sourceDir: resolvedRoot,
          artifactDir: resolvedArtifacts,
          profile,
          timeoutMs: Number(process.env.BOB_WORKER_TIMEOUT_MS || 10 * 60 * 1000),
          memory: workerMemory(profile),
          cpus: process.env.BOB_WORKER_CPUS || '1',
          pidsLimit: Number(process.env.BOB_WORKER_PIDS_LIMIT || 128),
          browserCheck: false,
          appUrl: null,
          env: undefined
        });

        if (outcome?.status === 'failed' || outcome?.exitCode !== 0) {
          attempt += 1;
          if (attempt <= maxRetries) {
            continue;
          }
        }
        break;
      }

      const terminalStatus = outcome?.status === 'failed' || outcome?.exitCode !== 0 ? 'failed' : 'succeeded';
      steps.push({
        profile,
        status: terminalStatus,
        exitCode: outcome?.exitCode ?? 0,
        stdout: outcome?.stdout || '',
        stderr: outcome?.stderr || '',
        artifactDir: resolvedArtifacts,
        requestedBy: 'self_hosted_bob',
        retriesUsed: Math.max(0, Number(outcome?.retriesUsed ?? 0))
      });

      if (terminalStatus === 'failed') {
        return {
          mode: 'self_hosted_bob',
          readOnly: true,
          assessment,
          plan,
          steps,
          paused: true,
          reason: `verification_failed:${profile}`
        };
      }
    }
  }

  return {
    mode: 'self_hosted_bob',
    readOnly: true,
    assessment,
    plan,
    steps,
    paused: false,
    reason: 'ready_for_human_approval'
  };
}

module.exports = { buildSelfHostedPlan, runSelfHostedBuildLoop, workerMemory };
