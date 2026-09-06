const crypto = require('node:crypto');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJobToken(claims, secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('workload signing secret must be at least 32 characters');
  }
  const required = ['inference_job_id', 'evidence_item_id', 'organization_id', 'jti'];
  if (!claims || required.some((name) => typeof claims[name] !== 'string' || !claims[name].trim()) || !Number.isSafeInteger(claims.exp)) {
    throw new TypeError('workload token claims are invalid');
  }
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const input = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

module.exports = { signJobToken };