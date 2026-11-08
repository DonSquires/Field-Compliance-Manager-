'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'bob-vps-docker.ps1'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'scripts', 'bob-gpu-link', 'README.md'), 'utf8');

test('VPS Docker helper stays on Tailscale and uses the existing key without embedding credentials', () => {
  assert.match(script, /100\.85\.95\.104/);
  assert.match(script, /private Tailscale IPv4 address/);
  assert.match(script, /BatchMode=yes/);
  assert.match(script, /fcm-vps-deploy/);
  assert.match(script, /docker version/);
  assert.doesNotMatch(script, /password|SUPABASE_SERVICE_ROLE_KEY|Authorization:\s*Bearer/i);
});

test('GPU link documentation records the tested private Docker route', () => {
  assert.match(readme, /Tested laptop-to-VPS Docker route/);
  assert.match(readme, /scripts\\bob-vps-docker\.ps1/);
  assert.match(readme, /100\.114\.240\.13/);
  assert.match(readme, /100\.85\.95\.104/);
});

test('officer privacy review reaches the authenticated control plane through an exact rate-limited route', () => {
  const nginx = fs.readFileSync(path.join(root, 'deploy', 'bob-vps', 'nginx', 'bob.fcmanager.co.nz'), 'utf8');
  const location = nginx.match(/location = \/api\/bob\/officer\/privacy\s*\{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(location, 'Private officer review needs an exact public proxy route');
  assert.match(location, /limit_req zone=bob_builder_api burst=5 nodelay;/);
  assert.match(location, /proxy_pass http:\/\/172\.16\.0\.1:8091;/);
  assert.match(location, /proxy_pass_request_headers on;/);
  assert.match(nginx, /location \/\s*\{\s*return 404;/);
});
