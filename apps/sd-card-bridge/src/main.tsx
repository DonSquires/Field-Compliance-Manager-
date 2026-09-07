import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getSupabaseClient } from './lib/supabase';
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const supabase = await getSupabaseClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      setPassword('');
      setSignedInAs(data.user?.email ?? email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in did not complete.');
    }
  };

  const signOut = async () => {
    const supabase = await getSupabaseClient();
    await supabase.auth.signOut();
    setSignedInAs(null);
    setVideo(null);
    setUploadStatus(null);
  };

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

  const uploadVideo = async () => {
    if (!video) return;
    setError(null);
    setUploadStatus('Preparing private video upload...');
    const supabase = await getSupabaseClient();
    const { data: sessionData } = await supabase.auth.getSession();
    const user = sessionData.session?.user;
    if (!user) {
      setError('Sign in before uploading a video.');
      setUploadStatus(null);
      return;
    }
    const attachmentId = crypto.randomUUID();
    const safeName = video.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'desktop-export.mp4';
    const storagePath = `desktop/${user.id}/${attachmentId}-${safeName}`;
    try {
      const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, video, {
        contentType: video.type || 'video/mp4', upsert: false,
      });
      if (uploadError) throw uploadError;
      setUploadStatus('Registering evidence and creating VPS inference job...');
      const { data, error: registerError } = await supabase.functions.invoke('register-desktop-video-import', {
        body: {
          attachment_id: attachmentId,
          storage_path: storagePath,
          file_name: video.name,
          file_type: video.type || 'video/mp4',
          file_size_bytes: video.size,
        },
      });
      if (registerError) throw registerError;
      setUploadStatus(`Uploaded. VPS inference job ${String(data?.inference_job_id ?? '').slice(0, 8)} is queued for CCTV Review.`);
      setVideo(null);
    } catch (cause) {
      await supabase.storage.from('bob-uploads').remove([storagePath]);
      setError(cause instanceof Error ? cause.message : 'Video upload did not complete.');
      setUploadStatus(null);
    }
  };

  return <main>
    <header>
      <div><span>FCM Local Utility</span><h1>SD Card Bridge</h1></div>
      <p>Read copied card indexes and validate media mapping before any export.</p>
    </header>
    <section className="notice"><strong>Read-only card access</strong><span>This version never writes to an SD card or accesses a physical disk. It keeps FCM sessions in memory and never stores service credentials.</span></section>
    <section className="tool bridge-session">
      {signedInAs ? <><strong>Signed in as {signedInAs}</strong><button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button></> : <form onSubmit={(event) => void signIn(event)}><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button type="submit">Sign in to FCM</button></form>}
    </section>
    <section className="tool">
      <button type="button" onClick={() => void inspectIndex()}>Choose SDFileInfo.db</button>
      <p>{status}</p>
      {error && <p className="error">{error}</p>}
    </section>
    <section className="tool upload-tool">
      <h2>Upload exported camera video</h2>
      <p>Select an MP4/MOV/AVI video already exported from the SD card. FCM will store it privately and queue the existing VPS inference pipeline.</p>
      <input type="file" accept="video/*,.avi,.mkv" disabled={!signedInAs} onChange={(event) => setVideo(event.target.files?.[0] ?? null)} />
      <button type="button" onClick={() => void uploadVideo()} disabled={!signedInAs || !video}>Upload to CCTV Review</button>
      {uploadStatus && <p>{uploadStatus}</p>}
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