export interface WorkloadTokenClaims {
  jobId: string;
  evidenceId: string;
  orgId: string;
}

interface WorkloadTokenPayload {
  inference_job_id: string;
  evidence_item_id: string;
  organization_id: string;
  jti: string;
  exp: number;
}

const TOKEN_TTL_SECONDS = 15 * 60;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function assertIdentifier(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

export async function generateWorkloadToken(
  claims: WorkloadTokenClaims,
  secretStr: string,
): Promise<string> {
  if (!claims || typeof claims !== 'object') {
    throw new TypeError('claims must be an object');
  }
  assertIdentifier('jobId', claims.jobId);
  assertIdentifier('evidenceId', claims.evidenceId);
  assertIdentifier('orgId', claims.orgId);
  assertIdentifier('secretStr', secretStr);

  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload: WorkloadTokenPayload = {
    inference_job_id: claims.jobId,
    evidence_item_id: claims.evidenceId,
    organization_id: claims.orgId,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const encodedPayload = encodeJson(payload);
  const signingInput = `${header}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}