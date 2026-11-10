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

function opaqueCommandProblem(segment, policy) {
  const { rest } = stripEnvAssignments(tokenize(segment));
  if (!rest.length) return null;
  const commandName = rest[0].replace(/^.*[\\/]/, '').toLowerCase();
  const opaque = policy.opaqueCommandPatterns.find((rule) => rule.regex.test(commandName));
  if (!opaque) return null;
  const target = policy.protectedCommandTargets.find((rule) => rule.regex.test(segment));
  if (!target) return null;
  return `This command passes a protected path to an inline interpreter. ${target.reason} ${opaque.reason}`;
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

function authorPreservationProblem(git, expected, ctx) {
  if (git.subcommand === 'commit' && git.args.includes('--amend') && !git.args.includes('--reset-author')) {
    const author = ctx.headAuthor();
    return author === expected ? null : `git commit --amend would preserve the existing author "${author || '(unavailable)'}", not "${expected}". Use --reset-author to create the amended commit with the verified identity.`;
  }
  if (git.subcommand === 'cherry-pick') {
    if (git.args.some((arg) => ['--abort', '--skip'].includes(arg))) return null;
    if (git.args.includes('--no-commit') || git.args.includes('-n')) return null;
    if (git.args.includes('--continue')) {
      const author = ctx.commitAuthor('CHERRY_PICK_HEAD');
      return author === expected ? null : `git cherry-pick --continue would preserve the author "${author || '(unavailable)'}", not "${expected}".`;
    }
    const skipValues = new Set(['-m', '--mainline', '-X', '--strategy-option']);
    const refs = [];
    for (let i = 0; i < git.args.length; i += 1) {
      const arg = git.args[i];
      if (skipValues.has(arg)) { i += 1; continue; }
      if (!arg.startsWith('-')) refs.push(arg);
    }
    if (!refs.length) return 'Cannot verify the author of the commit(s) git cherry-pick will preserve; specify the commit(s) explicitly.';
    for (const ref of refs) {
      const authors = ctx.commitAuthors(ref);
      if (!Array.isArray(authors) || !authors.length) return `Cannot verify the author of "${ref}" before cherry-picking.`;
      const foreign = authors.find((author) => author !== expected);
      if (foreign) return `git cherry-pick would preserve the author "${foreign}", not "${expected}".`;
    }
  }
  if (git.subcommand === 'rebase') {
    if (git.args.some((arg) => ['--abort', '--skip'].includes(arg))) return null;
    if (git.args.includes('--continue')) {
      const author = ctx.commitAuthor('REBASE_HEAD');
      return author === expected ? null : `git rebase --continue would preserve the author "${author || '(unavailable)'}", not "${expected}".`;
    }
    if (git.args.includes('--root')) return 'Cannot verify authors for git rebase --root; use an explicit upstream so replayed authors can be checked.';
    const values = new Set(['--onto', '--exec', '--strategy', '--strategy-option', '--whitespace', '--gpg-sign']);
    const positionals = [];
    let onto = false;
    for (let i = 0; i < git.args.length; i += 1) {
      const arg = git.args[i];
      if (arg === '--onto') { onto = true; i += 1; continue; }
      if (arg.startsWith('--onto=')) { onto = true; continue; }
      if (values.has(arg)) { i += 1; continue; }
      if (!arg.startsWith('-')) positionals.push(arg);
    }
    const upstream = onto ? positionals[0] : (positionals[0] || ctx.upstream());
    const branch = onto ? (positionals[1] || 'HEAD') : (positionals[1] || 'HEAD');
    if (!upstream) return 'Cannot determine the upstream range for git rebase; specify it explicitly so replayed authors can be checked.';
    const authors = ctx.rebaseAuthors(upstream, branch);
    if (!Array.isArray(authors)) return `Cannot verify the authors in ${upstream}..${branch} before rebasing.`;
    const foreign = authors.find((author) => author !== expected);
    if (foreign) return `git rebase would preserve the author "${foreign}", not "${expected}".`;
  }
  if (git.subcommand === 'am' && !git.args.some((arg) => ['--abort', '--skip'].includes(arg))) {
    return 'git am applies patch authors unchanged; it is blocked unless the commit author can be verified as the release identity.';
  }
  return null;
}

function identityProblem(git, policy, ctx) {
  const want = policy.releaseIdentity;
  if (!want || !IDENTITY_SUBCOMMANDS.has(git.subcommand)) return null;
  const configName = git.overrides['user.name'] ?? ctx.gitConfig('user.name');
  const configEmail = git.overrides['user.email'] ?? ctx.gitConfig('user.email');
  const identities = [
    `${git.env.GIT_AUTHOR_NAME ?? configName} <${git.env.GIT_AUTHOR_EMAIL ?? configEmail}>`,
    `${git.env.GIT_COMMITTER_NAME ?? configName} <${git.env.GIT_COMMITTER_EMAIL ?? configEmail}>`,
  ];
  const authorIndex = git.args.findIndex((a) => a === '--author' || a.startsWith('--author='));
  const author = authorIndex < 0 ? null : (git.args[authorIndex].includes('=') ? git.args[authorIndex].split('=').slice(1).join('=') : git.args[authorIndex + 1]);
  const expected = `${want.name} <${want.email}>`;
  if (author != null && author.trim() !== expected) return `git ${git.subcommand} --author must be "${expected}". ${want.reason || ''}`.trim();
  const wrongIdentity = identities.find((identity) => identity !== expected);
  if (wrongIdentity) {
    return `git ${git.subcommand} would use identity "${wrongIdentity}". Run: git config user.name "${want.name}" && git config user.email "${want.email}". ${want.reason || ''}`.trim();
  }
  return authorPreservationProblem(git, expected, ctx);
}

const PUSH_FLAGS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushProblem(git, policy, ctx) {
  if (git.subcommand !== 'push' || !policy.protectedBranches.length) return null;
  if (git.args.some((a) => a === '--dry-run' || a === '-n')) return null;
  const positional = [];
  let explicitRemote = false;
  for (let i = 0; i < git.args.length; i += 1) {
    const arg = git.args[i];
    if (PUSH_FLAGS_WITH_VALUE.has(arg)) {
      if (arg === '--repo') explicitRemote = true;
      i += 1;
      continue;
    }
    if (PUSH_FLAGS_WITH_VALUE.has(arg.split('=', 1)[0]) && arg.includes('=')) {
      if (arg.startsWith('--repo=')) explicitRemote = true;
      continue;
    }
    if (arg === '--all' || arg === '--mirror' || arg === '--branches') return `git push ${arg} would update protected branches. Push one feature branch instead.`;
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const current = () => ctx.currentBranch();
  const refspecs = explicitRemote ? positional : positional.slice(1);
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
  for (const segment of splitSegments(command)) {
    const problem = opaqueCommandProblem(segment, policy);
    if (problem) return { deny: problem };
  }
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

function gitOutputOrNull(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function defaultContext(input) {
  const projectDir = projectDirFrom(input);
  const cwd = input?.cwd || projectDir;
  return {
    projectDir,
    gitConfig: (key) => gitOutput(['config', '--get', key], cwd),
    currentBranch: () => gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    upstream: () => gitOutput(['rev-parse', '--symbolic-full-name', '@{upstream}'], cwd) || null,
    headAuthor: () => gitOutput(['show', '-s', '--format=%an <%ae>', 'HEAD'], cwd) || null,
    commitAuthor: (ref) => gitOutput(['show', '-s', '--format=%an <%ae>', ref], cwd) || null,
    commitAuthors: (ref) => {
      const output = gitOutputOrNull(['log', '--format=%an <%ae>', ref], cwd);
      return output == null ? null : (output ? output.split(/\r?\n/) : []);
    },
    rebaseAuthors: (upstream, branch) => {
      const output = gitOutputOrNull(['log', '--format=%an <%ae>', `${upstream}..${branch}`], cwd);
      return output == null ? null : (output ? output.split(/\r?\n/) : []);
    },
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
