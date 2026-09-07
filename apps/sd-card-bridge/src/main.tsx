import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import './styles.css';

type IndexRecord = {
  record_number: number;
  channel: number;
  start_time_utc: string | null;
  end_time_utc: string | null;
  length_bytes: number;
  cluster_number: number;
  index_in_cluster: number;
  event_names: string[];
};

type IndexReport = {
  database_path: string;
  database_sha256: string;
  record_count: number;
  valid_timestamped_record_count: number;
  event_definitions: string[];
  records: IndexRecord[];
};

function App() {
  const [report, setReport] = useState<IndexReport | null>(null);
  const [status, setStatus] = useState('Choose a copied SD-card index database to inspect it.');
  const [error, setError] = useState<string | null>(null);

  const inspectIndex = async () => {
    setError(null);
    const selected = await open({
      title: 'Select SDFileInfo.db from a copied SD-card folder',
      multiple: false,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (typeof selected !== 'string') return;
    setStatus('Reading the copied SQLite index in read-only mode...');
    try {
      const result = await invoke<IndexReport>('inspect_sd_index', { databasePath: selected });
      setReport(result);
      setStatus(`Read ${result.valid_timestamped_record_count} timestamped recording entries. No video was extracted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('Inspection did not complete.');
    }
  };

  return <main>
    <header>
      <div><span>FCM Local Utility</span><h1>SD Card Bridge</h1></div>
      <p>Read copied card indexes and validate media mapping before any export.</p>
    </header>
    <section className="notice"><strong>Read-only milestone</strong><span>This version never writes to an SD card, never accesses a physical disk, and never stores FCM credentials.</span></section>
    <section className="tool">
      <button type="button" onClick={() => void inspectIndex()}>Choose SDFileInfo.db</button>
      <p>{status}</p>
      {error && <p className="error">{error}</p>}
    </section>
    {report && <section className="results">
      <div className="metrics"><Metric label="Indexed recordings" value={report.record_count} /><Metric label="Usable timestamps" value={report.valid_timestamped_record_count} /><Metric label="Event definitions" value={report.event_definitions.filter(Boolean).length} /></div>
      <p className="hash">Source hash: {report.database_sha256}</p>
      <h2>Motion recording index</h2>
      <table><thead><tr><th>Record</th><th>Channel</th><th>Start UTC</th><th>End UTC</th><th>Bytes</th><th>Cluster</th><th>Events</th></tr></thead><tbody>
        {report.records.slice(0, 100).map((record) => <tr key={record.record_number}><td>{record.record_number}</td><td>{record.channel}</td><td>{record.start_time_utc ?? 'Missing'}</td><td>{record.end_time_utc ?? 'Missing'}</td><td>{record.length_bytes.toLocaleString()}</td><td>{record.cluster_number}:{record.index_in_cluster}</td><td>{record.event_names.filter(Boolean).join(', ') || 'Unlabelled'}</td></tr>)}
      </tbody></table>
    </section>}
  </main>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);