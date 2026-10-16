#!/usr/bin/env node
// Boots each Supabase Edge Function module under Deno with the HTTP listener stubbed, so a
// module-level error (duplicate declaration, bad import, top-level throw) fails here instead of
// shipping as a live BOOT_ERROR. 2026-10-16: a duplicate `const` kept onspace-ai-chat down for two days.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const functionsDir = join(root, 'supabase', 'functions');

const BOOT_PLACEHOLDER_ENV = Object.freeze({
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'boot-check',
  SUPABASE_SERVICE_ROLE_KEY: 'boot-check',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'boot-check' }),
  GITEA_BASE_URL: 'http://127.0.0.1:3000',
  GITEA_TOKEN: 'boot-check',
  VERCEL_TOKEN: 'boot-check',
  VERCEL_TEAM_ID: 'boot-check',
  STACK_RELAY_BASE_URL: 'http://127.0.0.1:8080',
  STACK_RELAY_TOKEN: 'boot-check',
});

export function listFunctions() {
  return readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && existsSync(join(functionsDir, entry.name, 'index.ts')))
    .map((entry) => entry.name)
    .sort();
}

export function denoAvailable() {
  return spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0;
}

export function bootFunction(name, { timeoutMs = 120000 } = {}) {
  const entry = pathToFileURL(join(functionsDir, name, 'index.ts')).href;
  const program = [
    'const noop = { finished: Promise.resolve(), shutdown: async () => {}, addr: { port: 0 }, ref() {}, unref() {} };',
    'Deno.serve = () => noop;',
    `await import(${JSON.stringify(entry)});`,
    'Deno.exit(0);',
  ].join('\n');
  const result = spawnSync('deno', ['eval', '--no-check', '--no-config', '--node-modules-dir=none', '--ext=ts', program], {
    cwd: join(functionsDir, name),
    encoding: 'utf8',
    timeout: timeoutMs,
    // Placeholder configuration only: real credentials are never handed to a boot probe.
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      DENO_NO_UPDATE_CHECK: '1',
      ...BOOT_PLACEHOLDER_ENV,
    },
  });
  const output = `${result.stderr || ''}${result.stdout || ''}`.split('\n').filter((line) => !/^Download /.test(line)).join('\n').trim();
  return { name, ok: result.status === 0, output: output.slice(-1200) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!denoAvailable()) {
    console.error('edge-boot-check: deno is not installed');
    process.exit(2);
  }
  const names = process.argv.slice(2).length ? process.argv.slice(2) : listFunctions();
  let failed = 0;
  for (const name of names) {
    const result = bootFunction(name);
    if (result.ok) console.log(`ok   ${name}`);
    else {
      failed += 1;
      console.error(`FAIL ${name}\n${result.output}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
