'use strict';

// Bob's VPS firewall (owner ruling 2026-10-21: worker network = tailnet, firewall = direct).
// Bob changes the host firewall himself, without a pull request, but only through structured
// rules (never a free-form shell string) in two Bob-owned iptables chains:
//   BOB-INPUT          jumped from INPUT        — traffic into the VPS
//   BOB-WORKER-EGRESS  jumped from DOCKER-USER  — traffic out of Bob's worker network
// The desired rule set is persisted and re-applied (flush + append) on every change and at
// control-plane start, so the live chains always equal the saved file. Every change is audited
// by the caller. Host commands run through one privileged helper container that enters the
// host's mount+network namespaces; the control plane already holds the host docker socket.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER_NETWORK = 'bob-workers';
const WORKER_SUBNET = '172.31.250.0/24';
const CHAINS = Object.freeze({ input: 'BOB-INPUT', worker_egress: 'BOB-WORKER-EGRESS' });
// Denying these would cut the owner, the public app or Tailscale off the VPS; refused outright.
const PROTECTED_INPUT_PORTS = Object.freeze([{ protocol: 'tcp', port: 22 }, { protocol: 'tcp', port: 80 }, { protocol: 'tcp', port: 443 }, { protocol: 'udp', port: 41641 }]);
const MAX_RULES = 200;

const CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;

function parsePort(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,5})(?:[:-](\d{1,5}))?$/);
  if (!match) throw new Error(`port must be a number or range like 8000:8100: ${text}`);
  const low = Number(match[1]);
  const high = match[2] ? Number(match[2]) : low;
  if (low < 1 || high > 65535 || low > high) throw new Error(`port out of range: ${text}`);
  return low === high ? String(low) : `${low}:${high}`;
}

function portCovers(port, target) {
  if (!port) return true;
  const [low, high = low] = port.split(':').map(Number);
  return target >= low && target <= high;
}

function normalizeRule(input) {
  if (!input || typeof input !== 'object') throw new Error('rule must be an object');
  const chain = String(input.chain || '').trim();
  if (!CHAINS[chain]) throw new Error('chain must be input or worker_egress');
  const action = String(input.action || '').trim();
  if (!['allow', 'deny'].includes(action)) throw new Error('action must be allow or deny');
  const protocol = String(input.protocol || 'tcp').trim().toLowerCase();
  if (!['tcp', 'udp', 'all'].includes(protocol)) throw new Error('protocol must be tcp, udp or all');
  const port = parsePort(input.port);
  if (port && protocol === 'all') throw new Error('a port needs protocol tcp or udp');
  const source = input.source ? String(input.source).trim() : null;
  const destination = input.destination ? String(input.destination).trim() : null;
  for (const [name, value] of [['source', source], ['destination', destination]]) {
    if (value && !CIDR.test(value)) throw new Error(`${name} must be an IPv4 address or CIDR: ${value}`);
  }
  if (chain === 'input' && destination) throw new Error('input rules match a source, not a destination');
  if (chain === 'worker_egress' && source) throw new Error('worker_egress rules always match the worker subnet; give a destination');
  const comment = String(input.comment || '').replace(/[^A-Za-z0-9 _.:/-]/g, '').trim().slice(0, 120);
  if (!comment) throw new Error('comment is required: say why the rule exists');
  if (chain === 'input' && action === 'deny') {
    if (!source && !port) throw new Error('refused: a deny-all input rule would lock everyone out of the VPS');
    const hit = PROTECTED_INPUT_PORTS.find(p => (protocol === 'all' || protocol === p.protocol) && portCovers(port, p.port));
    if (hit && !source) throw new Error(`refused: denying ${hit.protocol}/${hit.port} to everyone would cut off SSH, the public app or Tailscale`);
    if (hit && source && (source === '0.0.0.0/0' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(source))) {
      throw new Error(`refused: denying ${hit.protocol}/${hit.port} to ${source} would cut off the owner's tailnet or everyone`);
    }
  }
  return { chain, action, protocol, port, source, destination, comment };
}

const ruleKey = rule => [rule.chain, rule.action, rule.protocol, rule.port || '', rule.source || '', rule.destination || ''].join('|');

function iptablesArgs(rule) {
  const args = ['-A', CHAINS[rule.chain]];
  if (rule.protocol !== 'all') args.push('-p', rule.protocol);
  if (rule.source) args.push('-s', rule.source);
  if (rule.destination) args.push('-d', rule.destination);
  if (rule.port) args.push('--dport', rule.port);
  args.push('-m', 'comment', '--comment', `bob: ${rule.comment}`);
  // In DOCKER-USER, RETURN hands the packet back to docker's own accept rules.
  args.push('-j', rule.action === 'deny' ? 'DROP' : rule.chain === 'input' ? 'ACCEPT' : 'RETURN');
  return args;
}

// The full, ordered command list that makes the live chains equal the desired rules. Plain argv
// arrays; each runs as `iptables <args>`. `ensure` entries tolerate "already exists".
function reconcilePlan(rules, subnet = WORKER_SUBNET) {
  return [
    { ensure: true, args: ['-N', CHAINS.input] },
    { ensure: true, args: ['-N', CHAINS.worker_egress] },
    { ensure: true, check: ['-C', 'INPUT', '-j', CHAINS.input], args: ['-I', 'INPUT', '1', '-j', CHAINS.input] },
    { ensure: true, check: ['-C', 'DOCKER-USER', '-s', subnet, '-j', CHAINS.worker_egress], args: ['-I', 'DOCKER-USER', '1', '-s', subnet, '-j', CHAINS.worker_egress] },
    { args: ['-F', CHAINS.input] },
    { args: ['-F', CHAINS.worker_egress] },
    ...rules.map(rule => ({ args: iptablesArgs(rule) })),
  ];
}

function hostCommandArgs(image, argv) {
  return ['run', '--rm', '--user', '0', '--privileged', '--pid=host', '--network=host', image, 'nsenter', '-t', '1', '-m', '-n', '--', ...argv];
}

function runDocker(args, { spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    const child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-256 * 1024); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function createFirewall({ stateDir, image, subnet = WORKER_SUBNET, spawnImpl = spawn } = {}) {
  const file = path.join(stateDir || '/data', 'firewall', 'rules.json');
  const host = (argv, options) => runDocker(hostCommandArgs(image, argv), { spawnImpl, ...options });
  let queue = Promise.resolve();
  const serial = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRule) : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`firewall rule file is unreadable: ${error.message}`);
    }
  }
  function save(rules) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ updated_at: new Date().toISOString(), rules }, null, 2));
    fs.renameSync(temp, file);
  }

  async function apply(rules) {
    if (!image) throw new Error('BOB_WORKER_IMAGE is not configured, so host firewall commands cannot run');
    for (const step of reconcilePlan(rules, subnet)) {
      if (step.check && (await host(['iptables', ...step.check])).code === 0) continue;
      const result = await host(['iptables', ...step.args]);
      if (result.code !== 0 && !(step.ensure && /exists/i.test(result.stderr))) {
        throw new Error(`iptables ${step.args.join(' ')} failed: ${result.stderr.trim().slice(0, 400)}`);
      }
    }
  }

  return {
    file,
    rules: load,
    reconcile: () => serial(async () => { const rules = load(); await apply(rules); return { ok: true, applied: rules.length }; }),
    change: ({ op, rule }) => serial(async () => {
      if (!['add', 'remove'].includes(op)) throw new Error('op must be add or remove');
      const normalized = normalizeRule(rule);
      const current = load();
      const key = ruleKey(normalized);
      const exists = current.some(entry => ruleKey(entry) === key);
      let next = current;
      if (op === 'add') {
        if (exists) return { ok: true, changed: false, rules: current };
        if (current.length >= MAX_RULES) throw new Error(`refused: more than ${MAX_RULES} Bob firewall rules`);
        next = [...current, normalized];
      } else {
        if (!exists) return { ok: true, changed: false, rules: current };
        next = current.filter(entry => ruleKey(entry) !== key);
      }
      try {
        await apply(next);
      } catch (error) {
        await apply(current).catch(() => {});
        throw error;
      }
      save(next);
      return { ok: true, changed: true, rule: normalized, rules: next };
    }),
    async status() {
      const [input, egress, ufw, tailscale] = await Promise.all([
        host(['iptables', '-S', CHAINS.input]),
        host(['iptables', '-S', CHAINS.worker_egress]),
        host(['ufw', 'status']),
        host(['tailscale', 'status']),
      ]);
      return {
        worker_network: { name: WORKER_NETWORK, subnet },
        desired_rules: load(),
        live: { [CHAINS.input]: input.stdout.trim() || input.stderr.trim(), [CHAINS.worker_egress]: egress.stdout.trim() || egress.stderr.trim() },
        ufw: ufw.stdout.trim() || ufw.stderr.trim(),
        tailscale: tailscale.stdout.trim().slice(0, 4000) || tailscale.stderr.trim(),
        protected_input_ports: PROTECTED_INPUT_PORTS,
      };
    },
  };
}

module.exports = { WORKER_NETWORK, WORKER_SUBNET, CHAINS, PROTECTED_INPUT_PORTS, normalizeRule, iptablesArgs, reconcilePlan, hostCommandArgs, createFirewall };
