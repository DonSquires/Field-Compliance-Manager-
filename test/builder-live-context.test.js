const assert = require('node:assert/strict');
const test = require('node:test');
const { collectBuilderLiveContext, LIVE_TABLES, atlasGaps, ATLAS_GAP_LIMIT } = require('../builder-live-context');

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
test('Builder live context names unwired live Atlas gaps, bounded, without columns or retired rows', async () => {
  const rows = [
    { entity_type: 'rpc', entity_name: 'compact_cctv_inference_results', present: true, wired: false, retirement_status: 'live' },
    { entity_type: 'table', entity_name: 'custodian_events', present: true, wired: false, retirement_status: 'live' },
    { entity_type: 'column', entity_name: 'vehicles.colour', present: true, wired: false, retirement_status: 'live' },
    { entity_type: 'rpc', entity_name: 'old_rpc', present: true, wired: false, retirement_status: 'legacy' },
    { entity_type: 'rpc', entity_name: 'wired_rpc', present: true, wired: true, retirement_status: 'live' }
  ];
  const supabase = {
    from(table) {
      if (table === 'bob_capability_map') return query({ data: rows, error: null });
      if (table === 'bob_app_map_edges') return query({ data: [], error: null });
      return { select: async () => ({ count: 0, error: null }) };
    }
  };
  const { atlas } = await collectBuilderLiveContext(supabase);
  assert.deepEqual(atlas.gaps.items.map(gap => gap.entity_name), ['compact_cctv_inference_results', 'custodian_events']);
  assert.equal(atlas.gaps.total, 2);
  assert.equal(atlas.gaps.truncated, false);
  const many = Array.from({ length: 80 }, (_, index) => ({ entity_type: 'rpc', entity_name: `gap_${String(index).padStart(2, '0')}`, present: true, wired: false, retirement_status: 'live' }));
  const bounded = atlasGaps(many);
  assert.equal(bounded.items.length, ATLAS_GAP_LIMIT);
  assert.equal(bounded.truncated, true);
});
