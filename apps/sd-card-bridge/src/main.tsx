import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { Camera, Database, ExternalLink, HardDrive, LogOut, MonitorPlay, Upload, Wifi } from 'lucide-react';
import { getSupabaseClient } from './lib/supabase';
import './styles.css';

const FCM_WEB_URL = 'https://field-compliance-manager-8hs8ed7et-iron-eagle-security.vercel.app';

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
  const [activeView, setActiveView] = useState<'home' | 'sd-import' | 'video-upload'>('home');

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

  return <main className="desktop-companion">
    <header className="companion-header">
      <div className="companion-brand"><img src="/icons/128x128.png" alt="Iron Eagle Security" /><div><span>Iron Eagle Security</span><h1>FCM Desktop</h1></div></div>
      {signedInAs ? <div className="companion-session"><span><Wifi size={14} /> Connected as {signedInAs}</span><button type="button" className="icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={17} /></button></div> : <form className="sign-in-form" onSubmit={(event) => void signIn(event)}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" required /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" required /><button type="submit">Sign in</button></form>}
    </header>
    <div className="companion-layout">
      <nav className="companion-nav" aria-label="FCM Desktop navigation">
        <button type="button" className={activeView === 'home' ? 'is-active' : ''} onClick={() => setActiveView('home')}><MonitorPlay size={18} /> Desktop home</button>
        <button type="button" className={activeView === 'sd-import' ? 'is-active' : ''} onClick={() => setActiveView('sd-import')}><HardDrive size={18} /> SD card import</button>
        <button type="button" className={activeView === 'video-upload' ? 'is-active' : ''} onClick={() => setActiveView('video-upload')}><Upload size={18} /> Video upload</button>
        <a href={FCM_WEB_URL} target="_blank" rel="noreferrer"><ExternalLink size={18} /> FCM web portal</a>
      </nav>
      <section className="companion-workspace">
        {error && <div className="companion-error" role="alert">{error}</div>}
        {!signedInAs && <section className="connection-notice"><strong>Sign in to begin</strong><span>Use your authorised FCM account. Desktop processing is local; evidence, approvals, and results remain centrally governed.</span></section>}
        {activeView === 'home' && <><div className="workspace-heading"><span>Local operations</span><h2>FCM desktop workspace</h2><p>Use local hardware and large-file tools here. Open the FCM web portal for live work queues, formal review, reporting, and approvals.</p></div><div className="capability-grid"><Capability icon={<HardDrive size={23} />} title="SD card import" detail="Inspect copied camera indexes and prepare evidence for review." action="Open importer" onClick={() => setActiveView('sd-import')} /><Capability icon={<Camera size={23} />} title="Camera evidence" detail="Upload exported footage and queue VPS motion, ALPR, and face analysis." action="Upload video" onClick={() => setActiveView('video-upload')} /><Capability icon={<Database size={23} />} title="Operations portal" detail="Open FCM web for CCTV Review, Parking, Freedom Camping, and approvals." action="Open FCM web" onClick={() => window.open(FCM_WEB_URL, '_blank', 'noopener,noreferrer')} /></div><section className="read-only-notice"><strong>Current local access</strong><span>This release never writes to an SD card or reads raw physical disks. It works with copied evidence while the vendor storage format is validated.</span></section></>}
        {activeView === 'sd-import' && <><div className="workspace-heading"><span>Evidence intake</span><h2>SD card recording index</h2><p>Select `SDFileInfo.db` from a copied SD-card folder. Keep the matching `-wal` and `-shm` files beside it.</p></div><section className="tool"><button type="button" onClick={() => void inspectIndex()}><Database size={16} /> Choose SDFileInfo.db</button><p>{status}</p></section></>}
        {activeView === 'video-upload' && <><div className="workspace-heading"><span>Evidence intake</span><h2>Upload camera video</h2><p>Select an exported MP4, MOV, AVI, or MKV. FCM stores it privately and queues VPS inference for CCTV Review.</p></div><section className="tool upload-tool"><input type="file" accept="video/*,.avi,.mkv" disabled={!signedInAs} onChange={(event) => setVideo(event.target.files?.[0] ?? null)} /><button type="button" onClick={() => void uploadVideo()} disabled={!signedInAs || !video}><Upload size={16} /> Upload to CCTV Review</button>{video && <p>Selected: {video.name} ({Math.ceil(video.size / 1024 / 1024)} MB)</p>}{uploadStatus && <p>{uploadStatus}</p>}</section></>}
    {report && <section className="results">
      <div className="metrics"><Metric label="Indexed recordings" value={report.record_count} /><Metric label="Usable timestamps" value={report.valid_timestamped_record_count} /><Metric label="Event definitions" value={report.event_definitions.filter(Boolean).length} /></div>
      <p className="hash">Source hash: {report.database_sha256}</p>
      <h2>Motion recording index</h2>
      <table><thead><tr><th>Record</th><th>Channel</th><th>Start UTC</th><th>End UTC</th><th>Bytes</th><th>Cluster</th><th>Events</th></tr></thead><tbody>
        {report.records.slice(0, 100).map((record) => <tr key={record.record_number}><td>{record.record_number}</td><td>{record.channel}</td><td>{record.start_time_utc ?? 'Missing'}</td><td>{record.end_time_utc ?? 'Missing'}</td><td>{record.length_bytes.toLocaleString()}</td><td>{record.cluster_number}:{record.index_in_cluster}</td><td>{record.event_names.filter(Boolean).join(', ') || 'Unlabelled'}</td></tr>)}
      </tbody></table>
    </section>}
      </section>
    </div>
  </main>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function Capability({ icon, title, detail, action, onClick }: { icon: React.ReactNode; title: string; detail: string; action: string; onClick: () => void }) {
  return <section className="capability"><span>{icon}</span><h3>{title}</h3><p>{detail}</p><button type="button" onClick={onClick}>{action}</button></section>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);