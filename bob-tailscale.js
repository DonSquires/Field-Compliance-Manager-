'use strict';

// Bob's Tailscale tailnet control (owner request 2026-10-21): device list and the ACL policy file
// through the Tailscale API v2. Credential: TAILSCALE_API_KEY (an API access token, tskey-api-…),
// or TAILSCALE_OAUTH_CLIENT_ID + TAILSCALE_OAUTH_CLIENT_SECRET (scopes policy_file, devices:core:read).
// A policy change is validated by Tailscale first, needs the ETag of the policy it replaces
// (no lost updates), keeps the replaced policy on disk for rollback, and must still grant the
// owner network access. Existing Tailscale SSH rules cannot be changed here.

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.tailscale.com/api/v2';
const MAX_POLICY_BYTES = 256 * 1024;

function tailscaleConfig(env = process.env) {
  const apiKey = String(env.TAILSCALE_API_KEY || '').trim();
  const clientId = String(env.TAILSCALE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.TAILSCALE_OAUTH_CLIENT_SECRET || '').trim();
  const tailnet = String(env.TAILSCALE_TAILNET || '-').trim() || '-';
  const owner = String(env.TAILSCALE_OWNER_LOGIN || '').trim();
  return { apiKey, clientId, clientSecret, tailnet, owner, configured: Boolean(apiKey || (clientId && clientSecret)) };
}

function ownerRetainsAccess(policy, owner) {
  if (!owner || !policy || typeof policy !== 'object') return false;
  const includes = (values, value) => Array.isArray(values) && values.includes(value);
  const grants = Array.isArray(policy.grants) ? policy.grants : [];
  const acls = Array.isArray(policy.acls) ? policy.acls : [];
  return grants.some(rule =>
    rule && Object.keys(rule).every(key => ['src', 'dst', 'ip'].includes(key)) &&
    includes(rule.src, owner) && includes(rule.dst, '*') && includes(rule.ip, '*')
  ) || acls.some(rule =>
    rule && Object.keys(rule).every(key => ['action', 'src', 'dst'].includes(key)) &&
    rule.action === 'accept' && includes(rule.src, owner) && includes(rule.dst, '*:*')
  );
}

function createTailscale({ env = process.env, stateDir = '/data', fetchImpl = fetch } = {}) {
  const config = tailscaleConfig(env);
  const historyDir = path.join(stateDir, 'tailscale', 'acl-history');
  let cachedToken = null;

  async function bearer() {
    if (config.apiKey) return config.apiKey;
    if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
    const response = await fetchImpl(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'client_credentials' }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`Tailscale OAuth token request failed (HTTP ${response.status})`);
    cachedToken = { value: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
    return cachedToken.value;
  }

  async function call(method, route, { body, headers = {} } = {}) {
    if (!config.configured) throw new Error('Tailscale API is not configured: set TAILSCALE_API_KEY (or TAILSCALE_OAUTH_CLIENT_ID/SECRET) in control-plane.env');
    const response = await fetchImpl(`${API}/tailnet/${encodeURIComponent(config.tailnet)}${route}`, {
      method,
      headers: { Authorization: `Bearer ${await bearer()}`, ...headers },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Tailscale API ${method} ${route} failed (HTTP ${response.status})`);
    return { text, etag: response.headers.get('etag') };
  }

  return {
    configured: config.configured,
    tailnet: config.tailnet,
    async status() {
      const { text } = await call('GET', '/devices');
      const devices = (JSON.parse(text).devices || []).map(d => ({
        name: d.name, hostname: d.hostname, addresses: d.addresses, os: d.os, user: d.user, tags: d.tags || [],
        last_seen: d.lastSeen, authorized: d.authorized, key_expiry_disabled: d.keyExpiryDisabled,
      }));
      return { tailnet: config.tailnet, devices };
    },
    async acl({ op, policy, ifMatch } = {}) {
      if (op === 'get') {
        const { text, etag } = await call('GET', '/acl', { headers: { Accept: 'application/json' } });
        return { policy: text, etag };
      }
      if (op !== 'set') throw new Error('op must be get or set');
      const next = String(policy ?? '');
      if (!next.trim()) throw new Error('policy is required');
      if (Buffer.byteLength(next) > MAX_POLICY_BYTES) throw new Error('policy is too large');
      if (!ifMatch) throw new Error('if_match is required: pass the etag from tailnet_acl get so a newer policy is never overwritten');
      let parsed;
      try {
        parsed = JSON.parse(next);
      } catch {
        throw new Error('policy must be valid JSON; comments and trailing commas are not accepted for writes');
      }
      if (!ownerRetainsAccess(parsed, config.owner)) throw new Error('refused: policy must explicitly grant the configured owner unrestricted network access');
      const validation = await call('POST', '/acl/validate', { body: next, headers: { 'Content-Type': 'application/hujson' } });
      const verdict = validation.text ? JSON.parse(validation.text) : {};
      if (verdict.message || (Array.isArray(verdict.data) && verdict.data.length)) {
        throw new Error(`Tailscale rejected the policy: ${JSON.stringify(verdict).slice(0, 600)}`);
      }
      const current = await call('GET', '/acl', { headers: { Accept: 'application/json' } });
      if (current.etag !== ifMatch) throw new Error('refused: the tailnet policy changed since you read it; get it again and re-apply your change');
      if (JSON.stringify(JSON.parse(current.text).ssh ?? []) !== JSON.stringify(parsed.ssh ?? [])) {
        throw new Error('refused: existing Tailscale SSH rules must remain unchanged');
      }
      fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
      const backup = path.join(historyDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.hujson`);
      fs.writeFileSync(backup, current.text, { mode: 0o600 });
      const saved = await call('POST', '/acl', { body: next, headers: { 'Content-Type': 'application/hujson', Accept: 'application/hujson', 'If-Match': ifMatch } });
      return { ok: true, etag: saved.etag, previous_policy_backup: backup };
    },
  };
}

module.exports = { tailscaleConfig, ownerRetainsAccess, createTailscale };
