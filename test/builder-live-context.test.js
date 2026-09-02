const assert = require('node:assert/strict');
const test = require('node:test');
const { collectBuilderLiveContext, LIVE_TABLES } = require('../builder-live-context');

function query(result) {
  return {
    select() { return this; },
    neq() { return this; },
    eq() { return this; },
    range: async () => result
  };
}

test('Builder live context exposes bounded Atlas aggregates and no operational row bodies', async () => {
  const supabase = {
    from(table) {
      if (table === 'bob_capability_map') return query({ data: [
        { entity_type: 'table', wired: true, exercised: true, last_refreshed_at: '2026-09-02T08:00:00.000Z' },
        { entity_type: 'rpc', wired: false, exercised: null, last_refreshed_at: '2026-09-02T09:00:00.000Z' }
      ], error: null });
      if (table === 'bob_app_map_edges') return query({ data: [
        { edge_kind: 'reads', last_refreshed_at: '2026-09-02T09:00:00.000Z' },
        { edge_kind: 'writes', last_refreshed_at: '2026-09-02T08:00:00.000Z' }
      ], error: null });
      return { select: async () => ({ count: table === 'welfare_alerts' ? 2 : 1, error: null }) };
    }
  };
  const context = await collectBuilderLiveContext(supabase);
  assert.equal(context.atlas.available, true);
  assert.equal(context.atlas.capability_count, 2);
  assert.equal(context.atlas.wired_capability_count, 1);
  assert.equal(context.atlas.edge_kinds.reads, 1);
  assert.equal(context.live_data.tables.length, LIVE_TABLES.length);
  assert.equal(context.live_data.tables.find(row => row.table === 'welfare_alerts').count, 2);
  assert.equal(JSON.stringify(context), JSON.stringify(context).replace(/"id"\s*:/g, ''));
});