const LIVE_TABLES = Object.freeze([
  'organizations',
  'user_profiles',
  'location_zones',
  'shifts',
  'welfare_alerts',
  'builder_jobs'
]);
const ATLAS_PAGE_SIZE = 1000;

function countBy(rows, key) {
  return (rows || []).reduce((counts, row) => {
    const value = String(row[key] ?? 'unknown');
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function latestTimestamp(rows) {
  return (rows || []).map(row => row.last_refreshed_at).filter(Boolean).sort().at(-1) || null;
}

async function tableCount(supabase, table) {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  return { table, count: error ? null : count ?? 0, available: !error };
}

async function fetchAll(queryFactory) {
  const rows = [];
  for (let offset = 0; ; offset += ATLAS_PAGE_SIZE) {
    const { data, error } = await queryFactory().range(offset, offset + ATLAS_PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data || []));
    if (!data || data.length < ATLAS_PAGE_SIZE) return { data: rows, error: null };
  }
}

async function collectBuilderLiveContext(supabase) {
  const [capabilitiesResult, edgesResult, tableCounts] = await Promise.all([
    fetchAll(() => supabase.from('bob_capability_map')
      .select('entity_type,present,wired,exercised,last_refreshed_at,retirement_status')
      .neq('retirement_status', 'retired')),
    fetchAll(() => supabase.from('bob_app_map_edges')
      .select('edge_kind,evidence_class,last_refreshed_at')
      .eq('retirement_status', 'live')),
    Promise.all(LIVE_TABLES.map(table => tableCount(supabase, table)))
  ]);
  const capabilities = capabilitiesResult.data || [];
  const edges = edgesResult.data || [];
  return {
    captured_at: new Date().toISOString(),
    atlas: {
      available: !capabilitiesResult.error && !edgesResult.error,
      capability_count: capabilities.length,
      capability_types: countBy(capabilities, 'entity_type'),
      wired_capability_count: capabilities.filter(row => row.wired === true).length,
      exercised_capability_count: capabilities.filter(row => row.exercised === true).length,
      edge_count: edges.length,
      edge_kinds: countBy(edges, 'edge_kind'),
      capability_last_refreshed_at: latestTimestamp(capabilities),
      edge_last_refreshed_at: latestTimestamp(edges),
      note: 'Atlas flow evidence and FK structure remain distinct; this snapshot contains aggregate health only.'
    },
    live_data: {
      scope: 'aggregate row counts only',
      tables: tableCounts
    }
  };
}

module.exports = { LIVE_TABLES, ATLAS_PAGE_SIZE, countBy, latestTimestamp, tableCount, fetchAll, collectBuilderLiveContext };