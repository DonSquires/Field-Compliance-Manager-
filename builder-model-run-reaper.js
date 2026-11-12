// A model run row stays "running" forever when its process dies mid-turn (the run never reaches
// its finish write). Those orphans hold release deploys behind "model run in flight" and make
// executeSingleModelRun refuse the same idempotency key as "already in progress", so Bob cannot
// progress the job himself. Only rows whose heartbeat is older than the longest legitimate run
// and whose job this control plane is not executing are finalised.
const MIN_STALE_AFTER_MS = 60 * 60_000;

async function finaliseOrphanedModelRuns({ supabase, staleAfterMs, isExecuting, now = Date.now() }) {
  if (!supabase) return { finalised: [] };
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < MIN_STALE_AFTER_MS) {
    throw new Error(`orphaned model run threshold must be at least ${MIN_STALE_AFTER_MS / 60_000} minutes`);
  }
  const cutoff = new Date(now - staleAfterMs).toISOString();
  const { data, error } = await supabase.from('builder_model_runs')
    .select('id,job_id,updated_at')
    .in('status', ['pending', 'running'])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(`orphaned model runs could not be listed: ${error.message || error.code || 'unknown error'}`);
  const finalised = [];
  const completedAt = new Date(now).toISOString();
  for (const run of data || []) {
    if (isExecuting(run.job_id)) continue;
    const idleMinutes = Math.round((now - Date.parse(run.updated_at)) / 60_000);
    // The status and heartbeat filters repeat so a run that resumed after the scan is left alone.
    const { data: updated, error: updateError } = await supabase.from('builder_model_runs')
      .update({
        status: 'failed',
        completed_at: completedAt,
        updated_at: completedAt,
        error: `abandoned: no heartbeat for ${idleMinutes} min and no live executor; finalised by the control plane so the job can retry`,
      })
      .eq('id', run.id)
      .in('status', ['pending', 'running'])
      .lt('updated_at', cutoff)
      .select('id');
    if (updateError) throw new Error(`orphaned model run ${run.id} could not be finalised: ${updateError.message || updateError.code || 'unknown error'}`);
    if (updated?.length) finalised.push(run.id);
  }
  return { finalised };
}

module.exports = { finaliseOrphanedModelRuns, MIN_STALE_AFTER_MS };
