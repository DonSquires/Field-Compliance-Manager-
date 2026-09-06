const { verifyJobToken } = require('./job_token_verifier');

async function verifyAndConsumeToken(token, secret, supabaseServiceClient) {
  const claims = verifyJobToken(token, secret);
  if (!supabaseServiceClient || typeof supabaseServiceClient.rpc !== 'function') {
    throw new TypeError('supabase service client is required');
  }

  const { data, error } = await supabaseServiceClient.rpc('consume_workload_token', {
    p_jti: claims.jti,
    p_job_id: claims.inference_job_id,
    p_org_id: claims.organization_id
  });
  if (error) throw new Error(`workload token consumption failed: ${error.message}`);
  if (data !== true) throw new Error('workload token has already been consumed or is invalid');
  return claims;
}

module.exports = { verifyAndConsumeToken };