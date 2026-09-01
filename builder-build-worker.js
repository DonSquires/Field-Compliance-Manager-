const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const sourceDir = process.argv[2] || '/workspace';
  // This is a worker verification build. Normal project type-checking avoids
  // TypeScript's incremental `.tsbuildinfo` write in the read-only source tree.
  run('npm', ['--prefix', 'apps/web', 'exec', 'tsc', '--', '-p', 'apps/web/tsconfig.json'], sourceDir);
  run('npm', [
    '--prefix', 'apps/web', 'exec', 'vite', '--',
    'build', '--configLoader', 'native'
  ], path.join(sourceDir, 'apps/web'));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
