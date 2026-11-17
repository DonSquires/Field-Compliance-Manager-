'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalSpawn = childProcess.spawn;

if (fs.existsSync('/var/run/docker.sock')) throw new Error('fixture tooling requires a socket-free worker');

childProcess.spawn = function spawnWithFixtureTooling(command, args, options = {}) {
  if (command !== 'docker' || args?.[0] !== 'run' || !args.includes('--entrypoint=/usr/bin/env') || process.env.PATH === '') {
    return originalSpawn.call(this, command, args, options);
  }

  const workspaceMount = args.find(value => /^type=bind,src=.+,dst=\/workspace$/.test(value));
  const workspace = workspaceMount && workspaceMount.slice('type=bind,src='.length, -',dst=/workspace'.length);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const realWorkspace = workspace && fs.realpathSync(workspace);
  if (!realWorkspace || !realWorkspace.startsWith(`${tempRoot}${path.sep}`)
    || !options.cwd || fs.realpathSync(options.cwd) !== realWorkspace) {
    throw new Error('fixture tooling accepts only temporary test workspaces');
  }
  if (!args.includes('--read-only') || !args.includes('--cap-drop=ALL')
    || !args.includes('--security-opt=no-new-privileges:true') || !args.includes('--network=bridge')
    || !args.includes(`--user=${process.getuid()}:${process.getgid()}`)
    || !args.some(value => String(value).endsWith('dst=/workspace/.git,readonly'))
    || args.some(value => String(value).includes('docker.sock'))) {
    throw new Error('fixture tooling requires the isolated launcher contract');
  }

  const aliasRoot = fs.mkdtempSync(path.join(tempRoot, 'main-health-tooling-'));
  const alias = path.join(aliasRoot, 'workspace');
  fs.symlinkSync(realWorkspace, alias, 'dir');
  const environment = {};
  let index = args.indexOf('--entrypoint=/usr/bin/env') + 1;
  while (args[index] === '--env') {
    const entry = args[index + 1];
    const equals = entry.indexOf('=');
    environment[entry.slice(0, equals)] = entry.slice(equals + 1).replaceAll('/workspace', alias);
    index += 2;
  }
  const commandArgs = args.slice(index + 1);
  if (!commandArgs.length) {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
    throw new Error('fixture tooling command is missing');
  }
  const child = originalSpawn.call(this, commandArgs[0], commandArgs.slice(1), {
    ...options, cwd: realWorkspace, env: environment,
  });
  const cleanup = () => fs.rmSync(aliasRoot, { recursive: true, force: true });
  child.once('error', cleanup);
  child.once('close', cleanup);
  return child;
};