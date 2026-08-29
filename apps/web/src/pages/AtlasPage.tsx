import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

type Capability = {
  entity_type: string;
  entity_name: string;
  present: boolean;
  wired: boolean;
  exercised: boolean | null;
  notes: string | null;
  refresh_source: string | null;
  retirement_status: string;
};

type Edge = {
  source_type: string;
  source_name: string;
  target_type: string;
  target_name: string;
  edge_kind: string;
  retirement_status: string;
};

const inferredCapabilities: Capability[] = [
  { entity_type: 'edge_function', entity_name: 'bob-query-atlas', present: true, wired: true, exercised: null, notes: 'Atlas query boundary', refresh_source: 'manual_seed', retirement_status: 'live' },
  { entity_type: 'table', entity_name: 'bob_capability_map', present: true, wired: true, exercised: null, notes: 'Capability truth map', refresh_source: 'schema_fk', retirement_status: 'live' },
  { entity_type: 'table', entity_name: 'bob_app_map_edges', present: true, wired: true, exercised: null, notes: 'Directed application terrain', refresh_source: 'schema_fk', retirement_status: 'live' },
  { entity_type: 'feature', entity_name: 'oracle-welfare-safety', present: true, wired: false, exercised: null, notes: 'Oracle truth-state seam requires live conductor integration', refresh_source: 'manual_seed', retirement_status: 'live' },
];

const inferredEdges: Edge[] = [
  { source_type: 'edge_function', source_name: 'bob-query-atlas', target_type: 'table', target_name: 'bob_capability_map', edge_kind: 'reads', retirement_status: 'live' },
  { source_type: 'edge_function', source_name: 'bob-query-atlas', target_type: 'table', target_name: 'bob_app_map_edges', edge_kind: 'reads', retirement_status: 'live' },
  { source_type: 'feature', source_name: 'oracle-welfare-safety', target_type: 'table', target_name: 'welfare_alerts', edge_kind: 'writes', retirement_status: 'live' },
];

async function queryAtlas(action: string) {
  const { data, error } = await supabase.functions.invoke('bob-query-atlas', { body: { action, limit: 200 } });
  if (error) throw error;
  return data as { results?: Capability[] | Edge[] };
}

export function AtlasPage() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capabilityData, edgeData] = await Promise.all([queryAtlas('capability_map'), queryAtlas('terrain_edges')]);
      setCapabilities((capabilityData.results as Capability[]) ?? []);
      setEdges((edgeData.results as Edge[]) ?? []);
      setLive(true);
    } catch (cause) {
      setCapabilities(inferredCapabilities);
      setEdges(inferredEdges);
      setLive(false);
      setError(cause instanceof Error ? cause.message : 'Atlas is unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    nodes: capabilities.length,
    wired: capabilities.filter((item) => item.wired).length,
    gaps: capabilities.filter((item) => item.present && (!item.wired || item.exercised === false)).length,
    edges: edges.length,
  }), [capabilities, edges]);

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap', marginBottom: 28 }}>
        <div>
          <div style={{ color: '#f0b35b', fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' }}>System recovery / Atlas</div>
          <h1 style={{ margin: '8px 0 6px', fontSize: 38, letterSpacing: '-0.02em' }}>What still exists, and what is wired?</h1>
          <p style={{ color: '#aab6c8', margin: 0, maxWidth: 680, lineHeight: 1.6 }}>A live map of recovered capabilities and proven application paths. Schema presence is not the same thing as a working feature.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} style={{ border: '1px solid #38506b', borderRadius: 6, background: '#132237', color: '#f4f7fb', padding: '11px 16px', cursor: loading ? 'wait' : 'pointer', fontWeight: 700 }}>{loading ? 'Refreshing...' : 'Refresh Atlas'}</button>
      </div>

      {error && <div style={{ borderLeft: '3px solid #e7a33e', background: '#241d13', color: '#f4d49e', padding: '12px 15px', marginBottom: 20 }}>Supabase Atlas is unavailable. Showing inferred reconstruction data. <span style={{ color: '#bcae97' }}>{error}</span></div>}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: live ? '#72d6a2' : '#f0b35b', fontSize: 12, marginBottom: 16 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />{live ? 'LIVE SUPABASE DATA' : 'INFERRED RECOVERY DATA'}</div>

      <section style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 30 }}>
        <Metric label="Capabilities" value={counts.nodes} detail="tracked nodes" />
        <Metric label="Wired" value={counts.wired} detail="connected to a path" accent="#72d6a2" />
        <Metric label="Gaps" value={counts.gaps} detail="needs reconstruction" accent="#ee8b78" />
        <Metric label="Live edges" value={counts.edges} detail="proven relationships" accent="#7db7e8" />
      </section>

      <div style={{ display: 'grid', gap: 22, gridTemplateColumns: 'minmax(0, 1.2fr) minmax(300px, .8fr)' }}>
        <Panel title="Capability map" subtitle="present / wired / exercised">
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}><thead><tr>{['Entity', 'Present', 'Wired', 'Exercised', 'Source'].map((heading) => <th key={heading} style={th}>{heading}</th>)}</tr></thead><tbody>{capabilities.map((item) => <tr key={`${item.entity_type}:${item.entity_name}`}><td style={td}><strong>{item.entity_name}</strong><small style={{ display: 'block', color: '#7e8ca1', marginTop: 4 }}>{item.entity_type}</small></td><td style={td}><Status value={item.present} /></td><td style={td}><Status value={item.wired} /></td><td style={td}><Status value={item.exercised} /></td><td style={{ ...td, color: '#9aa8bb' }}>{item.refresh_source ?? 'unknown'}</td></tr>)}</tbody></table></div>
        </Panel>
        <Panel title="Terrain edges" subtitle="live directed relationships">
          <div style={{ display: 'grid', gap: 13 }}>{edges.map((edge) => <div key={`${edge.source_name}:${edge.target_name}:${edge.edge_kind}`} style={{ borderBottom: '1px solid #26364a', paddingBottom: 12 }}><div style={{ color: '#f1f4f8', fontSize: 14 }}>{edge.source_name} <span style={{ color: '#e2a65d', padding: '0 5px' }}>{edge.edge_kind}</span> {edge.target_name}</div><div style={{ color: '#78879a', fontSize: 11, marginTop: 5 }}>{edge.source_type} to {edge.target_type}</div></div>)}</div>
        </Panel>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, accent = '#f0b35b' }: { label: string; value: number; detail: string; accent?: string }) {
  return <div style={{ borderTop: `2px solid ${accent}`, background: '#101d2d', padding: '17px 18px' }}><div style={{ color: '#98a7b9', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.3 }}>{label}</div><div style={{ color: '#f4f7fb', fontSize: 31, fontWeight: 700, marginTop: 10 }}>{value}</div><div style={{ color: '#718197', fontSize: 12, marginTop: 3 }}>{detail}</div></div>;
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <section style={{ background: '#101d2d', border: '1px solid #26364a', padding: 20 }}><div style={{ marginBottom: 18 }}><h2 style={{ margin: 0, fontSize: 19 }}>{title}</h2><div style={{ color: '#78879a', fontSize: 12, marginTop: 5 }}>{subtitle}</div></div>{children}</section>;
}

function Status({ value }: { value: boolean | null }) {
  const label = value === null ? 'unknown' : value ? 'yes' : 'no';
  return <span style={{ color: value === null ? '#8895a7' : value ? '#72d6a2' : '#ee8b78', fontSize: 12, fontWeight: 700 }}>{label}</span>;
}

const th = { color: '#78879a', fontSize: 11, fontWeight: 700, letterSpacing: 1, textAlign: 'left' as const, textTransform: 'uppercase' as const, padding: '0 10px 11px 0', borderBottom: '1px solid #31445b' };
const td = { color: '#d9e0e9', fontSize: 13, padding: '13px 10px 13px 0', borderBottom: '1px solid #26364a', verticalAlign: 'top' as const };