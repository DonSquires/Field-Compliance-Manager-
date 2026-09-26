'use strict';

/**
 * Bob's terminal on the owner's laptop (owner instruction, 2026-09-26: "give Bob Windows
 * PowerShell so he can access files on my computer if I want him to, and a terminal to work
 * with"). The laptop runs Windows OpenSSH Server, reachable only over the private Tailscale
 * network (scripts/bob-gpu-link/laptop-tailscale.ps1 installs it, restricts the firewall to
 * the VPS's Tailscale address, and lets the owner start/stop it: -Allow / -Deny).
 *
 * Every command runs as PowerShell via `-EncodedCommand` (no shell quoting), under a timeout,
 * with capped and redacted output. The primary gate is the owner's per-command confirmation
 * in chat; the deny list below is defence in depth against clearly destructive or
 * privilege-changing operations, not a substitute for it.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_COMMAND_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const DENIED_PATTERNS = [
  [/Remove-Item\b[^\n]*-Recurse|\brm\s+-r|\brmdir\s+\/s|\bdel\s+\/[sq]|\brd\s+\/s/i, 'recursive delete'],
  [/Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|\bdiskpart\b|\bbcdedit\b|\bformat\s+[a-z]:/i, 'disk or boot change'],
  [/Stop-Computer|Restart-Computer|\bshutdown\b(?:\.exe)?\s|\blogoff\b/i, 'power or session change'],
  [/Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|Disable-WindowsOptionalFeature/i, 'security posture change'],
  [/New-LocalUser|Remove-LocalUser|Add-LocalGroupMember|Set-LocalUser|\bnet\s+(user|localgroup)\b/i, 'account change'],
  [/(Set|New|Remove|Clear|Rename)-Item(Property)?\b[^\n]*(HKLM:|HKEY_LOCAL_MACHINE)|\breg(\.exe)?\s+(add|delete|import|restore)\b/i, 'machine registry change'],
  [/(Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|curl|wget)[^\n]*\|\s*(iex|Invoke-Expression)/i, 'download-and-execute'],
  [/Get-Credential|\bcmdkey\b|\bvaultcmd\b|Export-PfxCertificate|Get-StoredCredential/i, 'credential access'],
  [/\.ssh[\\/](id_[a-z0-9]+|authorized_keys|administrators_authorized_keys)|ProgramData[\\/]ssh/i, 'ssh key material'],
  [/(New|Remove|Set|Disable|Enable)-NetFirewall(Rule|Profile)|netsh\s+advfirewall/i, 'firewall change'],
  [/Register-ScheduledTask|schtasks(\.exe)?\s+\/create|New-Service|sc(\.exe)?\s+create/i, 'persistence'],
  [/(Stop|Set|Remove)-Service\s+['"]?sshd|tailscale(\.exe)?\s+(down|logout|set)/i, 'would cut Bob\'s own link'],
];

function commandPolicy(command) {
  if (typeof command !== 'string' || !command.trim()) return { allowed: false, reason: 'command is empty' };
  if (command.length > MAX_COMMAND_CHARS) return { allowed: false, reason: `command exceeds ${MAX_COMMAND_CHARS} characters` };
  if (command.includes('\0')) return { allowed: false, reason: 'command contains a NUL byte' };
  for (const [pattern, reason] of DENIED_PATTERNS) {
    if (pattern.test(command)) return { allowed: false, reason: `refused: ${reason}` };
  }
  return { allowed: true, reason: null };
}

// PowerShell -EncodedCommand takes UTF-16LE base64: no quoting, no operators escaping.
function encodePowerShell(command) {
  return Buffer.from(String(command), 'utf16le').toString('base64');
}

function redact(value) {
  return String(value || '')
    .replace(/authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/(token|secret|password|passwd|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]');
}

function laptopConfig(env = process.env) {
  const enabled = String(env.BOB_LAPTOP_SHELL_ENABLED || '').toLowerCase() === 'true';
  const host = String(env.BOB_LAPTOP_HOST || '').trim();
  const user = String(env.BOB_LAPTOP_SSH_USER || '').trim();
  const keyPath = String(env.BOB_LAPTOP_SSH_KEY || '/data/laptop/id_ed25519').trim();
  const knownHosts = String(env.BOB_LAPTOP_KNOWN_HOSTS || path.join(path.dirname(keyPath), 'known_hosts')).trim();
  const port = Number(env.BOB_LAPTOP_SSH_PORT || 22);
  const missing = [];
  if (!enabled) missing.push('BOB_LAPTOP_SHELL_ENABLED');
  if (!host) missing.push('BOB_LAPTOP_HOST');
  if (!user) missing.push('BOB_LAPTOP_SSH_USER');
  if (!fs.existsSync(keyPath)) missing.push('BOB_LAPTOP_SSH_KEY (file)');
  // Tailscale addresses only: the laptop is never reached over the public internet.
  if (host && !/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host)) missing.push('BOB_LAPTOP_HOST (must be a Tailscale address)');
  return { enabled, host, user, keyPath, knownHosts, port, configured: missing.length === 0, missing };
}

function sshArguments(config, command, { connectTimeoutSeconds = 10 } = {}) {
  return [
    '-i', config.keyPath,
    '-p', String(config.port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${config.knownHosts}`,
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'LogLevel=ERROR',
    `${config.user}@${config.host}`,
    'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encodePowerShell(command),
  ];
}

function runSsh(config, command, { timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnImpl('ssh', sshArguments(config, command), { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' } });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const collect = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > MAX_OUTPUT_BYTES) { stdout += text.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length)); truncated = true; } else stdout += text;
      } else if (stderr.length + text.length > 8192) { stderr += text.slice(0, Math.max(0, 8192 - stderr.length)); truncated = true; } else stderr += text;
    };
    child.stdout.on('data', (c) => collect(c, 'out'));
    child.stderr.on('data', (c) => collect(c, 'err'));
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exit_code: null, stdout: '', stderr: redact(error.message), timed_out: false, truncated: false, duration_ms: Date.now() - started, error: `ssh could not start: ${redact(error.message)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // ssh exits 255 for its own failures (unreachable, refused key, host key changed).
      const sshFailure = code === 255 ? (redact(stderr).trim() || 'ssh connection failed') : null;
      resolve({ ok: !timedOut && code === 0, exit_code: code, stdout: redact(stdout), stderr: redact(stderr), timed_out: timedOut, truncated, duration_ms: Date.now() - started, error: timedOut ? `timed out after ${timeoutMs} ms` : sshFailure });
    });
  });
}

/** Run one PowerShell command on the laptop. Policy is enforced here as well as by the caller. */
async function runLaptopCommand({ command, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, spawnImpl = spawn }) {
  const config = laptopConfig(env);
  if (!config.configured) return { ok: false, status: 503, error: `laptop shell is not available (${config.missing.join(', ')})`, exit_code: null };
  const policy = commandPolicy(command);
  if (!policy.allowed) return { ok: false, status: 403, error: policy.reason, exit_code: null };
  const bounded = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5_000), MAX_TIMEOUT_MS);
  const result = await runSsh(config, command, { timeoutMs: bounded, spawnImpl });
  return {
    ...result,
    status: result.ok ? 200 : (result.timed_out ? 408 : (result.exit_code === 255 || result.exit_code === null ? 502 : 200)),
    command_sha256: crypto.createHash('sha256').update(command).digest('hex'),
    host: config.host,
    user: config.user,
  };
}

/** Is the laptop reachable and accepting Bob's key right now? */
async function laptopStatus({ env = process.env, spawnImpl = spawn } = {}) {
  const config = laptopConfig(env);
  const base = { enabled: config.enabled, configured: config.configured, missing: config.missing, host: config.host || null, user: config.user || null };
  if (!config.configured) return { ...base, reachable: false };
  const probe = await runSsh(config, '$PSVersionTable.PSVersion.ToString(); $env:USERNAME; $env:COMPUTERNAME', { timeoutMs: 20_000, spawnImpl });
  const lines = probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { ...base, reachable: probe.ok, powershell: probe.ok ? lines[0] ?? null : null, remote_user: probe.ok ? lines[1] ?? null : null, computer: probe.ok ? lines[2] ?? null : null, error: probe.ok ? null : probe.error, latency_ms: probe.duration_ms };
}

module.exports = { DENIED_PATTERNS, MAX_COMMAND_CHARS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, commandPolicy, encodePowerShell, laptopConfig, laptopStatus, redact, runLaptopCommand, sshArguments };
