const test = require('node:test');
const assert = require('node:assert/strict');
const { finaliseOrphanedModelRuns } = require('../builder-model-run-reaper');

function fakeSupabase(rows) {
  const updates = [];
  const query = (state) => ({
    select() { return query(state); },
    in(column, values) { return query({ ...state, filters: [...state.filters, row => values.includes(row[column])] }); },
    lt(column, value) { return query({ ...state, filters: [...state.filters, row => row[column] < value] }); },
    eq(column, value) { return query({ ...state, filters: [...state.filters, row => row[column] === value] }); },
    order() { return query(state); },
    limit() { return query(state); },
    update(patch) { return query({ ...state, patch }); },
    then(resolve) {
      const matched = rows.filter(row => state.filters.every(filter => filter(row)));
      if (state.patch) {
        for (const row of matched) { Object.assign(row, state.patch); updates.push({ id: row.id, ...state.patch }); }
        return resolve({ data: matched.map(row => ({ id: row.id })), error: null });
      }
      return resolve({ data: matched.map(row => ({ ...row })), error: null });
    },
  });
  return { updates, from: () => query({ filters: [] }) };
}

const NOW = Date.parse('2026-11-12T10:00:00Z');
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();

test('finalises a running model run with no heartbeat past the lease and no live executor', async () => {
  const rows = [
    { id: 'orphan', job_id: 'dead-job', status: 'running', updated_at: minutesAgo(140) },
    { id: 'live-heartbeat', job_id: 'other-job', status: 'running', updated_at: minutesAgo(5) },
    { id: 'executing', job_id: 'live-job', status: 'running', updated_at: minutesAgo(140) },
    { id: 'done', job_id: 'dead-job', status: 'completed', updated_at: minutesAgo(300) },
  ];
  const supabase = fakeSupabase(rows);
  const result = await finaliseOrphanedModelRuns({ supabase, staleAfterMs: 120 * 60_000, isExecuting: jobId => jobId === 'live-job', now: NOW });
  assert.deepEqual(result.finalised, ['orphan']);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /no heartbeat for 140 min/);
  assert.match(rows[0].error, /no live executor/);
  assert.equal(rows[0].completed_at, new Date(NOW).toISOString());
  assert.equal(rows[1].status, 'running');
  assert.equal(rows[2].status, 'running');
  assert.equal(rows[3].status, 'completed');
});

test('a heartbeat that lands between the scan and the update keeps the run alive', async () => {
  const rows = [{ id: 'revived', job_id: 'job', status: 'running', updated_at: minutesAgo(200) }];
  const supabase = fakeSupabase(rows);
  const original = supabase.from;
  supabase.from = () => {
    const builder = original();
    const update = builder.update;
    builder.update = (patch) => { rows[0].updated_at = new Date(NOW).toISOString(); return update.call(builder, patch); };
    return builder;
  };
  const result = await finaliseOrphanedModelRuns({ supabase, staleAfterMs: 120 * 60_000, isExecuting: () => false, now: NOW });
  assert.deepEqual(result.finalised, []);
  assert.equal(rows[0].status, 'running');
});

test('refuses to run with an unsafe threshold or without a client', async () => {
  await assert.rejects(finaliseOrphanedModelRuns({ supabase: fakeSupabase([]), staleAfterMs: 60_000, isExecuting: () => false }), /threshold/);
  assert.deepEqual(await finaliseOrphanedModelRuns({ supabase: null, staleAfterMs: 120 * 60_000, isExecuting: () => false }), { finalised: [] });
});
