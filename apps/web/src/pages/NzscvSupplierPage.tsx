import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BarChart3, Car, Database, RefreshCw, Search, ShieldCheck, Signpost, TriangleAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './NzscvSupplierPage.css';

interface SupplierSummary {
  registry_total: number;
  active: number;
  expired: number;
  suspended: number;
  cancelled: number;
  expiring_90_days: number;
  last_registry_update: string | null;
  freedom_camping_lookups_30_days: number;
  freedom_camping_lookups_total: number;
}
interface UsagePoint { date: string; lookups: number }
interface ImportHealth { id: string; source_name: string; status: string; total_rows: number; valid_rows: number; inserted_rows: number; updated_rows: number; skipped_rows: number; invalid_rows: number; started_at: string | null; completed_at: string | null; created_at: string }
interface RegisterRow { id: string; plate_number: string; certificate_number: string | null; certificate_status: string; issued_date: string | null; expiry_date: string | null }
interface SupplierDashboard {
  summary: SupplierSummary;
  daily_usage: UsagePoint[];
  imports: ImportHealth[];
  records: RegisterRow[];
  page: { limit: number; offset: number; search: string };
  privacy: { usage_is_aggregate: boolean; tenant_details_included: boolean; officer_details_included: boolean; incident_details_included: boolean; raw_source_rows_included: boolean };
}

const PAGE_SIZE = 25;
const EMPTY_SUMMARY: SupplierSummary = { registry_total: 0, active: 0, expired: 0, suspended: 0, cancelled: 0, expiring_90_days: 0, last_registry_update: null, freedom_camping_lookups_30_days: 0, freedom_camping_lookups_total: 0 };

function dateWords(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not supplied';
}
function statusWords(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export default function NzscvSupplierPage() {
  const { profile, signOut } = useAuth();
  const [dashboard, setDashboard] = useState<SupplierDashboard | null>(null);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase.rpc('get_nzscv_supplier_dashboard', { p_search: submittedSearch || null, p_limit: PAGE_SIZE, p_offset: offset });
    if (loadError) {
      setDashboard(null);
      setError(loadError.message);
    } else setDashboard((data as SupplierDashboard | null) ?? null);
    setLoading(false);
  }, [offset, submittedSearch]);

  useEffect(() => { void load(); }, [load]);

  if (!['nzscv_monitor', 'grand_master'].includes(profile?.role ?? '')) {
    return <main className="nzscv-access"><strong>NZSCV supplier access required</strong><button type="button" onClick={() => void signOut()}>Sign out</button></main>;
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const next = search.trim();
    setOffset(0);
    if (next === submittedSearch) void load(); else setSubmittedSearch(next);
  };
  const summary = dashboard?.summary ?? EMPTY_SUMMARY;
  const maxUsage = Math.max(1, ...(dashboard?.daily_usage ?? []).map((point) => point.lookups));
  const records = dashboard?.records ?? [];

  return <div className="nzscv-portal">
    <header className="nzscv-topbar">
      <div className="nzscv-brand"><img src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg" alt="Iron Eagle Security" /><div><strong>NZSCV registry</strong><span>Supplier transparency</span></div></div>
      <div className="nzscv-account"><span>{profile?.displayName ?? 'NZSCV supplier'}</span><button type="button" onClick={() => void signOut()}>Sign out</button></div>
    </header>

    <main className="nzscv-main">
      <header className="nzscv-heading">
        <div><span>Freedom Camping lookup service</span><h1>Registry use and data quality</h1><p>See the public certificate data supplied to Field Compliance Manager and how often it supports Freedom Camping checks.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} aria-hidden="true" /> Refresh</button>
      </header>

      <div className="nzscv-privacy" role="note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Aggregate use only</strong><span>No client, officer, incident, location, photo, or raw source-row details are included.</span></div></div>
      {error && <div className="nzscv-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div><strong>Registry data could not be loaded</strong><span>{error}</span></div><button type="button" onClick={() => void load()}>Try again</button></div>}

      <section className="nzscv-summary" aria-label="Registry summary">
        <div><Database size={19} aria-hidden="true" /><span>Registry records</span><strong>{loading ? '…' : summary.registry_total.toLocaleString('en-NZ')}</strong></div>
        <div><ShieldCheck size={19} aria-hidden="true" /><span>Active certificates</span><strong>{loading ? '…' : summary.active.toLocaleString('en-NZ')}</strong></div>
        <div className={summary.expiring_90_days ? 'is-watch' : ''}><Signpost size={19} aria-hidden="true" /><span>Expiring in 90 days</span><strong>{loading ? '…' : summary.expiring_90_days.toLocaleString('en-NZ')}</strong></div>
        <div><BarChart3 size={19} aria-hidden="true" /><span>Lookups in 30 days</span><strong>{loading ? '…' : summary.freedom_camping_lookups_30_days.toLocaleString('en-NZ')}</strong></div>
      </section>

      <div className="nzscv-layout">
        <section className="nzscv-usage" aria-labelledby="nzscv-usage-title">
          <div className="nzscv-section-heading"><div><span>Aggregate analytics</span><h2 id="nzscv-usage-title">Freedom Camping lookup use</h2></div><small>{summary.freedom_camping_lookups_total.toLocaleString('en-NZ')} matched lookups in total</small></div>
          {loading ? <div className="nzscv-empty"><RefreshCw className="is-spinning" size={20} /> Loading usage</div> : <div className="nzscv-chart" role="img" aria-label="Daily matched Freedom Camping lookups for the last 30 days">{(dashboard?.daily_usage ?? []).map((point) => <div key={point.date}><span style={{ height: `${Math.max(3, (point.lookups / maxUsage) * 100)}%` }} title={`${point.lookups} lookups on ${dateWords(point.date)}`} /><small>{new Date(`${point.date}T12:00:00`).toLocaleDateString('en-NZ', { day: 'numeric' })}</small></div>)}</div>}
        </section>

        <aside className="nzscv-imports" aria-labelledby="nzscv-imports-title">
          <div className="nzscv-section-heading"><div><span>Data freshness</span><h2 id="nzscv-imports-title">Recent register loads</h2></div></div>
          {!loading && (dashboard?.imports.length ?? 0) === 0 ? <div className="nzscv-empty">No register loads recorded.</div> : <div className="nzscv-import-list">{dashboard?.imports.map((batch) => <article key={batch.id}><div><strong>{dateWords(batch.completed_at ?? batch.created_at)}</strong><span className={`status-${batch.status}`}>{statusWords(batch.status)}</span></div><p>{batch.valid_rows.toLocaleString('en-NZ')} valid · {batch.inserted_rows.toLocaleString('en-NZ')} added · {batch.updated_rows.toLocaleString('en-NZ')} updated</p>{batch.invalid_rows > 0 && <small>{batch.invalid_rows.toLocaleString('en-NZ')} invalid rows require source correction</small>}</article>)}</div>}
        </aside>
      </div>

      <section className="nzscv-register" aria-labelledby="nzscv-register-title">
        <div className="nzscv-register-heading"><div><span>Supplied data</span><h2 id="nzscv-register-title">Self-contained vehicle register</h2><p>Public certificate fields only. Search by plate or certificate number.</p></div><form onSubmit={submitSearch}><Search size={16} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search plate or certificate" aria-label="Search plate or certificate" /><button type="submit">Search</button></form></div>
        {loading ? <div className="nzscv-empty"><RefreshCw className="is-spinning" size={20} /> Loading register</div> : records.length === 0 ? <div className="nzscv-empty"><Car size={20} /> No certificate records match this search.</div> : <div className="nzscv-table-wrap"><table><thead><tr><th>Plate</th><th>Certificate</th><th>Status</th><th>Issued</th><th>Expires</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td><strong>{record.plate_number}</strong></td><td>{record.certificate_number ?? 'Not supplied'}</td><td><span className={`status-${record.certificate_status}`}>{statusWords(record.certificate_status)}</span></td><td>{dateWords(record.issued_date)}</td><td>{dateWords(record.expiry_date)}</td></tr>)}</tbody></table></div>}
        <footer><span>{records.length ? `Showing ${offset + 1}–${offset + records.length}` : 'No matching rows'}</span><div><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button><button type="button" disabled={loading || records.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button></div></footer>
      </section>
    </main>
  </div>;
}
