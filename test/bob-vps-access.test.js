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
