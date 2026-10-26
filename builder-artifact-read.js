'use strict';

const crypto = require('node:crypto');
const { unwrapPatchArtifact } = require('./supabase/functions/_shared/builder-patch-envelope');

async function downloadVerifiedArtifact(supabase, artifactId, jobId, expectedType, { allowSuperseded = false } = {}) {
  const { data: artifact, error } = await supabase.from('builder_artifacts')
    .select('id, job_id, step_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId).eq('job_id', jobId).single();
  if (error || !artifact || artifact.artifact_type !== expectedType
      || (artifact.status !== 'final' && !(allowSuperseded && artifact.status === 'superseded'))) {
    throw new Error(`final ${expectedType} artifact is unavailable`);
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error('artifact provenance is invalid');
  }
  const { data: object, error: downloadError } = await supabase.storage.from('builder-artifacts')
    .download(artifact.storage_location.slice(prefix.length));
  if (downloadError || !object) throw new Error('artifact could not be downloaded');
  const bytes = Buffer.from(await object.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.checksum) {
    throw new Error('artifact integrity check failed');
  }
  return { artifact, bytes };
}

async function loadCodeReviewSeed(supabase, job, step) {
  if (!job.code_review_revision) return null;
  const artifactId = job.code_review_revision.seed_patch_ids?.[step.step_id];
  if (!artifactId) throw new Error('Confirmed code review correction has no seed for this implementation lane');
  const downloaded = await downloadVerifiedArtifact(supabase, artifactId, job.id, 'code_implementation', { allowSuperseded: true });
  if (downloaded.artifact.step_id !== step.id) throw new Error('Correction seed belongs to a different implementation step');
  const { patch } = unwrapPatchArtifact(downloaded.bytes);
  if (!patch?.trim()) throw new Error('Code review correction seed is empty');
  return { text: patch, from_job: job.id, artifact_id: artifactId };
}

module.exports = { downloadVerifiedArtifact, loadCodeReviewSeed };
