'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createAssessment } = require('./assessment-manifest');

const execute = promisify(execFile);
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"image_id":{{json .Image}},"status":{{json .State.Status}},"running":{{json .State.Running}},"restart_count":{{json .RestartCount}},"compose_project":{{json (index .Config.Labels "com.docker.compose.project")}},"compose_service":{{json (index .Config.Labels "com.docker.compose.service")}},"compose_config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"compose_working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}';
const ACTIONS = Object.freeze({
  assessment: 'Inventory the deployed control-plane source: revision, packages, Compose service names and function count. Not a live host filesystem check.',
  docker_services: 'List up to 30 host Docker containers with selected lifecycle metadata, excluding commands, environment, logs and mounts.',
  docker_container: 'Read selected lifecycle metadata for one discovered host Docker container. Compose labels record creation configuration, not proof that referenced paths still exist.',
});
const PLATFORM_CONTRACTS = Object.freeze({
  platform_capabilities: { properties: {} },
  inspect_platform: {
    properties: { action: { type: 'string', enum: Object.keys(ACTIONS) }, container: { type: 'string', pattern: CONTAINER.source } },
    required: ['action'],
  },
});
const PLATFORM_DESCRIPTIONS = Object.freeze({
  platform_capabilities: 'Discover implemented read-only platform actions, argument contracts, evidence limits and whether availability has been probed. Discovery does not prove health.',
  inspect_platform: 'Inspect deployed source or host Docker lifecycle metadata. Choose an action from platform_capabilities. No shell, logs, environment values or mutations.',
});

function createPlatformTools({ sourceRoot, run = execute, assess = createAssessment, audit = () => {}, now = () => new Date().toISOString() }) {
  const docker = async args => {
    const result = await run('docker', args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return result.stdout.trim();
  };
  const inspect = async container => JSON.parse(await docker(['container', 'inspect', '--format', INSPECT_FORMAT, container]));
  return {
    platform_capabilities: async () => ({
      scope: 'platform owner engineering lanes', effects: 'read_only',
      actions: Object.entries(ACTIONS).map(([action, description]) => ({
        action, description, implemented: true, availability: 'not_probed',
        arguments: { action, ...(action === 'docker_container' ? { container: 'required: discovered container name or id' } : {}) },
      })),
      contracts: PLATFORM_CONTRACTS,
    }),
    inspect_platform: async (args = {}) => {
      const { action, container } = args;
      if (!Object.hasOwn(ACTIONS, action) || Object.keys(args).some(key => !['action', 'container'].includes(key))
        || (action === 'docker_container' ? typeof container !== 'string' || !CONTAINER.test(container) : container !== undefined)) {
        audit({ action: typeof action === 'string' && Object.hasOwn(ACTIONS, action) ? action : 'invalid', ok: false, code: 'INVALID_INPUT' });
        return { error: 'Choose a supported action; only docker_container accepts and requires a discovered container name/id.', code: 'INVALID_INPUT' };
      }
      const evidence = { observed_at: now(), environment: action === 'assessment' ? 'deployed_control_plane_source' : 'host_docker_daemon', action, read_only: true };
      try {
        let data;
        if (action === 'assessment') {
          const result = assess(sourceRoot);
          data = {
            revision: result.git.commit, file_count: result.fileCount,
            packages: result.packages.map(({ file, name }) => ({ file, name })),
            compose: result.compose, edge_function_count: result.supabaseEdgeFunctions.length,
            secret_files_excluded: result.secretFilesExcluded,
          };
        } else if (action === 'docker_container') {
          data = await inspect(container);
        } else {
          const ids = (await docker(['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'])).split('\n').filter(Boolean);
          if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Unexpected Docker inventory');
          const services = [];
          for (const id of ids.slice(0, 30)) services.push(await inspect(id));
          data = { services, total: ids.length, truncated: ids.length > services.length };
        }
        audit({ action, ok: true, observed_at: evidence.observed_at });
        return { data, evidence };
      } catch {
        audit({ action, ok: false, code: 'DIAGNOSTIC_FAILED', observed_at: evidence.observed_at });
        return { error: 'Platform diagnostic failed. Check the deployed source directory or Docker daemon access; no successful observation was obtained.', code: 'DIAGNOSTIC_FAILED', evidence };
      }
    },
  };
}

module.exports = { createPlatformTools, PLATFORM_CONTRACTS, PLATFORM_DESCRIPTIONS };
