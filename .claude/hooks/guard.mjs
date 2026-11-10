#!/usr/bin/env node
// Claude Code PreToolUse guard. Every rule comes from policy.json; this file only interprets it.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPolicy, projectDirFrom, protectedRuleFor } from './lib.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const IDENTITY_SUBCOMMANDS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am']);

function tokenize(segment) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function splitSegments(command) {
  return String(command || '').split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

function stripEnvAssignments(tokens) {
  const env = {};
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    const [key, ...rest] = tokens[i].split('=');
    env[key] = rest.join('=');
    i += 1;
  }
  return { env, rest: tokens.slice(i) };
}

function shellWriteTargets(command) {
  const targets = [];
  const redirect = /(?:^|[^<>&\d])\d?>>?(?!&)\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g;
  let m;
  while ((m = redirect.exec(command))) targets.push(m[1]);
  for (const segment of splitSegments(command)) {
    const { rest } = stripEnvAssignments(tokenize(segment));
    const [cmd, ...args] = rest;
    const operands = args.filter((a) => !a.startsWith('-'));
    if (!cmd) continue;
    const name = cmd.replace(/^.*[\\/]/, '');
    if (name === 'tee' || name === 'rm' || name === 'truncate' || name === 'unlink') targets.push(...operands);
    else if ((name === 'cp' || name === 'install') && operands.length) targets.push(operands[operands.length - 1]);
    else if (name === 'mv') targets.push(...operands);
    else if ((name === 'sed' || name === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) targets.push(...operands.slice(1));
    else if (/^(Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|New-Item)$/i.test(name)) {
      const pathFlag = args.findIndex((a) => /^-(Path|FilePath|LiteralPath)$/i.test(a));
      targets.push(pathFlag >= 0 ? args[pathFlag + 1] : operands[0]);
    }
  }
  return targets.filter(Boolean);
}

function parseGit(tokens) {
  const { env, rest } = stripEnvAssignments(tokens);
  if (rest[0] !== 'git') return null;
  const overrides = {};
  let i = 1;
  while (i < rest.length && rest[i].startsWith('-')) {
    if (rest[i] === '-c' && rest[i + 1]) {
      const [key, ...value] = rest[i + 1].split('=');
      overrides[key.toLowerCase()] = value.join('=');
      i += 2;
    } else if (rest[i] === '-C' || rest[i] === '--git-dir' || rest[i] === '--work-tree') i += 2;
    else i += 1;
  }
  return { env, overrides, subcommand: rest[i], args: rest.slice(i + 1) };
}

function identityProblem(git, policy, ctx) {
  const want = policy.releaseIdentity;
  if (!want || !IDENTITY_SUBCOMMANDS.has(git.subcommand)) return null;
  const email = git.env.GIT_AUTHOR_EMAIL ?? git.env.GIT_COMMITTER_EMAIL ?? git.overrides['user.email'] ?? ctx.gitConfig('user.email');
  const name = git.env.GIT_AUTHOR_NAME ?? git.env.GIT_COMMITTER_NAME ?? git.overrides['user.name'] ?? ctx.gitConfig('user.name');
  const authorIndex = git.args.findIndex((a) => a === '--author' || a.startsWith('--author='));
  const author = authorIndex < 0 ? null : (git.args[authorIndex].includes('=') ? git.args[authorIndex].split('=').slice(1).join('=') : git.args[authorIndex + 1]);
  const expected = `${want.name} <${want.email}>`;
  if (author != null && author.trim() !== expected) return `git ${git.subcommand} --author must be "${expected}". ${want.reason || ''}`.trim();
  if (email !== want.email || name !== want.name) {
    return `git ${git.subcommand} would use identity "${name || '(unset)'} <${email || '(unset)'}>". Run: git config user.name "${want.name}" && git config user.email "${want.email}". ${want.reason || ''}`.trim();
  }
  return null;
}

const PUSH_FLAGS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushProblem(git, policy, ctx) {
  if (git.subcommand !== 'push' || !policy.protectedBranches.length) return null;
  if (git.args.some((a) => a === '--dry-run' || a === '-n')) return null;
  const positional = [];
  for (let i = 0; i < git.args.length; i += 1) {
    const arg = git.args[i];
    if (PUSH_FLAGS_WITH_VALUE.has(arg)) { i += 1; continue; }
    if (arg === '--all' || arg === '--mirror' || arg === '--branches') return `git push ${arg} would update protected branches. Push one feature branch instead.`;
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const current = () => ctx.currentBranch();
  const refspecs = positional.slice(1);
  const destinations = refspecs.length ? refspecs.map((spec) => {
    const clean = spec.replace(/^\+/, '');
    const dst = clean.includes(':') ? clean.split(':').pop() : clean;
    return dst === 'HEAD' || dst === '' ? current() : dst;
  }) : [current()];
  for (const dst of destinations) {
    const branch = String(dst || '').replace(/^refs\/heads\//, '');
    const rule = policy.protectedBranches.find((b) => b.name === branch);
    if (rule) return `git push to protected branch "${branch}" is blocked. ${rule.reason || ''}`.trim();
  }
  return null;
}

export function evaluate(input, policy, ctx) {
  const projectDir = ctx.projectDir;
  const tool = input?.tool_name;
  const toolInput = input?.tool_input || {};
  if (EDIT_TOOLS.has(tool)) {
    const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
    const rule = protectedRuleFor(target, policy, projectDir, input.cwd || projectDir);
    return rule ? { deny: `${target} is protected. ${rule.reason}` } : null;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(toolInput.command || '');
  for (const target of shellWriteTargets(command)) {
    const rule = protectedRuleFor(target, policy, projectDir, input.cwd || projectDir);
    if (rule) return { deny: `This command writes to ${target}, which is protected. ${rule.reason}` };
  }
  for (const segment of splitSegments(command)) {
    const git = parseGit(tokenize(segment));
    if (!git) continue;
    const problem = identityProblem(git, policy, ctx) || pushProblem(git, policy, ctx);
    if (problem) return { deny: problem };
  }
  return null;
}

function gitOutput(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function defaultContext(input) {
  const projectDir = projectDirFrom(input);
  const cwd = input?.cwd || projectDir;
  return {
    projectDir,
    gitConfig: (key) => gitOutput(['config', '--get', key], cwd),
    currentBranch: () => gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  };
}

function respond(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  let policy;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.stderr.write('policy guard: could not parse hook input; blocking to stay safe.');
    process.exit(2);
  }
  try {
    policy = loadPolicy();
  } catch (error) {
    respond(`policy guard: .claude/hooks/policy.json could not be loaded (${error.message}); fix it before continuing.`);
    return;
  }
  const decision = evaluate(input, policy, defaultContext(input));
  if (decision?.deny) respond(decision.deny);
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
