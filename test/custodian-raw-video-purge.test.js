'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runPurge } = require('../scripts/custodian-raw-video-purge');

const candidate = (id) => ({ evidence_id: id, storage_bucket: 'bob-uploads', storage_paths: [`org/x/cctv/${id}.dav`, `org/x/cctv/${id}.playback.mp4`] });

function fakeBackend(batches, { recordFails = [], deleteFails = [] } = {}) {
  const calls = [];
  const queue = [...batches];
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push(`${fn}:${args.p_evidence_id ?? args.p_limit}`);
      if (fn === 'custodian_raw_video_purge_candidates') return queue.shift() ?? [];
      if (recordFails.includes(args.p_evidence_id)) throw new Error('not eligible');
      const c = batches.flat().find((x) => x.evidence_id === args.p_evidence_id);
      return { storage_bucket: c.storage_bucket, storage_paths: c.storage_paths };
    },
    deleteObjects: async (bucket, paths) => {
      calls.push(`delete:${bucket}:${paths.join('|')}`);
      if (deleteFails.some((id) => paths[0].includes(`/${id}.`))) throw new Error('storage 500');
    },
  };
}

test('a dry run lists candidates and never records or deletes', async () => {
  const backend = fakeBackend([[candidate('a'), candidate('b')]]);
  const summary = await runPurge({ ...backend, apply: false, limit: 50, log: () => {} });
  assert.deepEqual(backend.calls, ['custodian_raw_video_purge_candidates:50']);
  assert.equal(summary.candidates, 2);
  assert.equal(summary.purged, 0);
});

test('apply records the purge before deleting the storage objects', async () => {
  const backend = fakeBackend([[candidate('a')]]);
  const summary = await runPurge({ ...backend, apply: true, limit: 50, log: () => {} });
  assert.deepEqual(backend.calls, [
    'custodian_raw_video_purge_candidates:50',
    'custodian_record_raw_video_purge:a',
    'delete:bob-uploads:org/x/cctv/a.dav|org/x/cctv/a.playback.mp4',
    'custodian_raw_video_purge_candidates:50',
  ]);
  assert.equal(summary.purged, 1);
});

test('a refused record (for example a new legal hold) leaves the objects in place', async () => {
  const backend = fakeBackend([[candidate('a'), candidate('b')]], { recordFails: ['a'] });
  const summary = await runPurge({ ...backend, apply: true, limit: 50, log: () => {} });
  assert.ok(!backend.calls.some((c) => c.startsWith('delete:') && c.includes('/a.')));
  assert.ok(backend.calls.some((c) => c.startsWith('delete:') && c.includes('/b.')));
  assert.deepEqual([summary.purged, summary.failed], [1, 1]);
});

test('apply stops when a batch makes no progress instead of looping', async () => {
  const stuck = [candidate('a')];
  const backend = fakeBackend([stuck, stuck, stuck, stuck], { deleteFails: ['a'] });
  const summary = await runPurge({ ...backend, apply: true, limit: 50, log: () => {} });
  assert.equal(backend.calls.filter((c) => c.startsWith('custodian_raw_video_purge_candidates')).length, 1);
  assert.deepEqual([summary.purged, summary.failed], [0, 1]);
});
