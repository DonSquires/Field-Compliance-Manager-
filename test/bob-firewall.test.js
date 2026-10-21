const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { normalizeRule, iptablesArgs, reconcilePlan, hostCommandArgs, createFirewall } = require('../bob-firewall');

test('rules are structured and validated, never free-form shell', () => {
  assert.deepEqual(normalizeRule({ chain: 'input', action: 'allow', protocol: 'tcp', port: '8080', source: '100.114.240.13', comment: 'laptop to api; probe' }),
    { chain: 'input', action: 'allow', protocol: 'tcp', port: '8080', source: '100.114.240.13', destination: null, comment: 'laptop to api probe' });
  assert.throws(() => normalizeRule({ chain: 'forward', action: 'allow', comment: 'x' }), /chain must be/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'allow', port: '22; reboot', comment: 'x' }), /port must be/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'allow', source: '$(id)', comment: 'x' }), /IPv4/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'allow', port: 80 }), /comment is required/);
  assert.throws(() => normalizeRule({ chain: 'worker_egress', action: 'deny', source: '1.2.3.4', comment: 'x' }), /worker subnet/);
});

test('lockout guard refuses denies that would cut off SSH, the app or the tailnet', () => {
  assert.throws(() => normalizeRule({ chain: 'input', action: 'deny', protocol: 'all', comment: 'x' }), /lock everyone out/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'deny', port: 22, comment: 'x' }), /SSH/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'deny', port: '1:1000', comment: 'x' }), /SSH/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'deny', protocol: 'udp', port: 41641, comment: 'x' }), /Tailscale/);
  assert.throws(() => normalizeRule({ chain: 'input', action: 'deny', port: 22, source: '100.114.240.13', comment: 'x' }), /tailnet/);
  assert.equal(normalizeRule({ chain: 'input', action: 'deny', port: 22, source: '203.0.113.9', comment: 'abuser' }).action, 'deny');
  assert.equal(normalizeRule({ chain: 'input', action: 'deny', port: 11434, comment: 'ollama not public' }).port, '11434');
});

test('iptables plan owns only the BOB chains and maps actions per chain', () => {
  assert.deepEqual(iptablesArgs(normalizeRule({ chain: 'worker_egress', action: 'deny', protocol: 'tcp', port: 5432, destination: '10.0.0.0/8', comment: 'no db' })),
    ['-A', 'BOB-WORKER-EGRESS', '-p', 'tcp', '-d', '10.0.0.0/8', '--dport', '5432', '-m', 'comment', '--comment', 'bob: no db', '-j', 'DROP']);
  assert.equal(iptablesArgs(normalizeRule({ chain: 'worker_egress', action: 'allow', protocol: 'all', destination: '1.1.1.1', comment: 'dns' })).at(-1), 'RETURN');
  const plan = reconcilePlan([]);
  assert.deepEqual(plan.find(step => step.check?.[1] === 'DOCKER-USER').args, ['-I', 'DOCKER-USER', '1', '-s', '172.31.250.0/24', '-j', 'BOB-WORKER-EGRESS']);
  assert.ok(plan.every(step => !step.args.includes('-F') || step.args[1].startsWith('BOB-')), 'only Bob chains are ever flushed');
  assert.deepEqual(hostCommandArgs('img', ['iptables', '-S']), ['run', '--rm', '--user', '0', '--privileged', '--pid=host', '--network=host', 'img', 'nsenter', '-t', '1', '-m', '-n', '--', 'iptables', '-S']);
});

function fakeDocker(failOn) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    const argv = args.slice(args.indexOf('--') + 1);
    calls.push(argv.join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const failing = failOn && failOn(argv);
      if (failing) child.stderr.emit('data', failing);
      child.emit('close', failing ? 1 : 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test('changes persist, re-apply idempotently, and roll back when iptables rejects them', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-fw-'));
  const docker = fakeDocker(argv => argv.includes('--dport') && argv.includes('9999') ? 'iptables: bad rule' : (argv[1] === '-N' ? 'Chain already exists.' : ''));
  const firewall = createFirewall({ stateDir, image: 'img', spawnImpl: docker.spawnImpl });
  const rule = { chain: 'input', action: 'allow', port: 8080, source: '100.114.240.13', comment: 'laptop' };
  const added = await firewall.change({ op: 'add', rule });
  assert.equal(added.changed, true);
  assert.equal(firewall.rules().length, 1);
  assert.equal((await firewall.change({ op: 'add', rule })).changed, false);
  await assert.rejects(firewall.change({ op: 'add', rule: { ...rule, port: 9999 } }), /bad rule/);
  assert.equal(firewall.rules().length, 1, 'a rejected rule is not saved');
  assert.ok(docker.calls.filter(call => call === 'iptables -F BOB-INPUT').length >= 3, 'the previous set is re-applied after a failure');
  await firewall.change({ op: 'remove', rule });
  assert.equal(firewall.rules().length, 0);
  assert.equal(JSON.parse(fs.readFileSync(firewall.file, 'utf8')).rules.length, 0);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('vibe builder and the owner control room can reach the firewall, nobody else', () => {
  const vibe = require('../builder-vibe-session');
  const prompt = vibe.vibeSystemPrompt();
  assert.match(prompt, /firewall_status \{\}/);
  assert.match(prompt, /firewall_change \{op: add\|remove/);
  assert.equal(vibe.PROMPT_VERSION, 'vibe-v4');
  const session = fs.readFileSync(path.join(__dirname, '..', 'builder-vibe-session.js'), 'utf8');
  assert.match(session, /if \(deps\.firewall\) \{\s*tools\.firewall_status/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'bob-control-plane-server.js'), 'utf8');
  assert.match(server, /'\/api\/bob\/firewall\/change'\) \{\s*if \(!authorized\(req\)\)/);
  assert.match(server, /record\(requestedBy, 'firewall\.change'/);
  const room = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'bob-builder-control-room', 'index.ts'), 'utf8');
  assert.match(room, /action === 'firewall_change'\) \{\s*if \(role !== 'grand_master'\)/);
});
