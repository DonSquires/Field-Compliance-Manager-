const crypto = require('node:crypto');

const REQUIRED_CLAIMS = [
  'inference_job_id',
  'evidence_item_id',
  'organization_id',
  'jti',
  'exp'
];

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_job_token');
  }
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('job token secret must be a string of at least 32 characters');
  }
}

function validateClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new TypeError('job token claims must be an object');
  }
  for (const claim of REQUIRED_CLAIMS.slice(0, -1)) {
    if (typeof claims[claim] !== 'string' || !claims[claim].trim()) {
      throw new TypeError(`job token claim ${claim} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(claims.exp)) {
    throw new TypeError('job token claim exp must be a Unix timestamp');
  }
}

function sign(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

function signJobToken(claims, secret) {
  validateSecret(secret);
  validateClaims(claims);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

function verifyJobToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  validateSecret(secret);
  if (typeof token !== 'string') throw new TypeError('job token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('invalid_job_token');

  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('invalid_job_token_algorithm');
  validateClaims(claims);

  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const received = Buffer.from(parts[2]);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw new Error('invalid_job_token_signature');
  }
  if (claims.exp <= nowSeconds) throw new Error('expired_job_token');
  return claims;
}

module.exports = { signJobToken, verifyJobToken };