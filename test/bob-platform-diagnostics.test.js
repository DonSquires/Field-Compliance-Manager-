'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformTools, PLATFORM_CONTRACTS } = require('../bob-platform-diagnostics');
const { createBuilderChatTools, builderChatNativeTools } = require('../builder-chat-session');

test('capability discovery describes supported contracts without claiming health or running commands', async () => {
  const tools = createPlatformTools({ run: () => assert.fail('discovery must not run commands') });
  const result = await tools.platform_capabilities();
  assert.deepEqual(result.actions.map(action => action.action), ['assessment', 'docker_services', 'docker_container']);
  assert.ok(result.actions.every(action => action.implemented && action.availability === 'not_probed'));
  assert.deepEqual(result.contracts, PLATFORM_CONTRACTS);
});

test('Docker inventory requests only selected metadata and returns bounded, dated evidence', async () => {
  const commands = [];
  const audits = [];
  const tools = createPlatformTools({
    now: () => '2026-10-25T09:00:00Z', audit: receipt => audits.push(receipt),
    run: async (command, args, options) => {
      commands.push({ command, args, options });
      if (args[1] === 'ls') return { stdout: Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(64, '0')).join('\n') };
      return { stdout: JSON.stringify({ id: args.at(-1), compose_config_files: '/srv/example/compose.yml', status: 'running' }) };
    },
  });
  const result = await tools.inspect_platform({ action: 'docker_services' });
  assert.equal(result.data.total, 32);
  assert.equal(result.data.services.length, 30);
  assert.equal(result.data.truncated, true);
  assert.deepEqual(result.evidence, { observed_at: '2026-10-25T09:00:00Z', environment: 'host_docker_daemon', action: 'docker_services', read_only: true });
  assert.equal(commands.length, 31);
  assert.ok(commands.every(call => call.command === 'docker' && call.options.timeout === 15000 && call.options.maxBuffer === 1048576));
  const format = commands[1].args[3];
  assert.doesNotMatch(format, /\.Env|\.Cmd|\.Mounts|\.Health|\.Log|\.Args/);
  assert.match(format, /com\.docker\.compose\.project\.config_files/);
  assert.deepEqual(audits, [{ action: 'docker_services', ok: true, observed_at: '2026-10-25T09:00:00Z' }]);
});

test('invalid input cannot become a Docker argument or an arbitrary operation', async () => {
  const tools = createPlatformTools({ run: () => assert.fail('invalid input must not execute') });
  for (const args of [
    { action: 'exec', container: 'app' }, { action: 'docker_container', container: '--help' },
    { action: 'docker_container', container: 'app;id' }, { action: 'docker_container' },
    { action: 'docker_container', container: '../app' }, { action: 'docker_services', command: 'env' },
    { action: 'assessment', container: 'app' },
  ]) {
    const result = await tools.inspect_platform(args);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.ok(result.error);
  }
});

test('single-container read validates selection and never reports a failure as successful data', async () => {
  const calls = [];
  const tools = createPlatformTools({ run: async (command, args) => {
    calls.push([command, args]);
    return { stdout: '{"name":"/example-api","running":true}' };
  } });
  assert.equal((await tools.inspect_platform({ action: 'docker_container', container: 'example-api' })).data.running, true);
  assert.equal(calls[0][1].at(-1), 'example-api');
  for (const run of [async () => { throw new Error('secret-from-stderr'); }, async () => ({ stdout: 'not JSON' })]) {
    const audits = [];
    const failed = await createPlatformTools({ run, audit: receipt => audits.push(receipt) }).inspect_platform({ action: 'docker_container', container: 'example-api' });
    assert.equal(failed.code, 'DIAGNOSTIC_FAILED');
    assert.equal(failed.data, undefined);
    assert.equal(audits[0].ok, false);
    assert.ok(!JSON.stringify(failed).includes('secret-from-stderr'));
  }
});

test('source assessment is scoped and does not expose full files, paths, git status or dependency values', async () => {
  const tools = createPlatformTools({ sourceRoot: '/deployed', assess: root => {
    assert.equal(root, '/deployed');
    return { git: { commit: 'revision', status: ['private-untracked'] }, fileCount: 5, files: ['private'], sourceRoot: root,
      packages: [{ file: 'package.json', name: 'example', dependencies: ['internal-dependency'] }],
      compose: [{ file: 'docker-compose.yml', services: ['app'] }], supabaseEdgeFunctions: ['example'], secretFilesExcluded: true };
  } });
  const result = await tools.inspect_platform({ action: 'assessment' });
  assert.equal(result.data.revision, 'revision');
  assert.equal(result.evidence.environment, 'deployed_control_plane_source');
  assert.doesNotMatch(JSON.stringify(result), /private|internal-dependency|\/deployed/);
});

test('Builder chat exposes only explicitly injected capability functions and complete contracts', async () => {
  const tools = createBuilderChatTools({ platformTools: {
    ...createPlatformTools({}), shell: () => assert.fail('must not expose shell'),
  } });
  assert.equal(typeof tools.inspect_platform, 'function');
  assert.equal(tools.shell, undefined);
  const absent = createBuilderChatTools({});
  assert.equal(absent.inspect_platform, undefined);
  const native = builderChatNativeTools(tools).find(entry => entry.function.name === 'inspect_platform').function;
  assert.deepEqual(native.parameters.properties.action.enum, ['assessment', 'docker_services', 'docker_container']);
  assert.equal(native.parameters.additionalProperties, false);
});
