'use strict';

async function accountVerifierRecoveries(supabase, jobId) {
  if (!supabase || typeof supabase.rpc !== 'function') return 0;
  const { data, error } = await supabase.rpc('builder_account_verifier_recoveries', { _job_id: jobId });
  if (error) throw new Error(`Verifier recovery accounting failed: ${error.message}`);
  if (!Number.isInteger(data) || data < 0) throw new Error('Verifier recovery accounting returned invalid evidence');
  return data;
}

module.exports = { accountVerifierRecoveries };
