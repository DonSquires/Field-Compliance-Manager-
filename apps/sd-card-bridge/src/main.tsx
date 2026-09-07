import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Camera, Database, ExternalLink, FileText, HardDrive, LogOut, MonitorPlay, RefreshCw, Upload, Wifi } from 'lucide-react';
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

type MountedFolderReport = {
  folder_path: string;
  file_count: number;
  total_bytes: number;
  truncated: boolean;
  files: Array<{ relative_path: string; size_bytes: number }>;
};

type RemovableDisk = {
  disk_number: number;
  friendly_name: string;
  bus_type: string;
  size_bytes: number;
  operational_status: string;
  partitions: Array<{
    partition_number: number;
    drive_letter: string | null;
    size_bytes: number;
    offset_bytes: number;
    filesystem: string | null;
    label: string | null;
  }>;
};

type PartitionProbe = {
  disk_number: number;
  partition_number: number;
  offset_bytes: number;
  bytes_read: number;
  sha256: string;
  signature: string;
  format_hint: string;
};

type ClusterMappingReport = {
  disk_number: number;
  partition_number: number;
  cluster_number: number;
  samples: Array<{
    multiplier_bytes: number;
    absolute_offset_bytes: number;
    sha256: string;
    signature: string;
    format_hint: string;
  }>;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  const [mountedFiles, setMountedFiles] = useState<MountedFolderReport | null>(null);
  const [removableDisks, setRemovableDisks] = useState<RemovableDisk[]>([]);
  const [diskLoading, setDiskLoading] = useState(false);
  const [partitionProbe, setPartitionProbe] = useState<PartitionProbe | null>(null);
  const [probeLoading, setProbeLoading] = useState<string | null>(null);
  const [clusterReport, setClusterReport] = useState<ClusterMappingReport | null>(null);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      setPassword('');
      setSignedInAs(data.user?.email ?? email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in did not complete.');
    }
  };

  const signOut = async () => {
    const supabase = getSupabaseClient();
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

  const inspectMountedFolder = async () => {
    setError(null);
    const selected = await open({ title: 'Select the mounted SD-card folder or drive root', directory: true, multiple: false });
    if (typeof selected !== 'string') return;
    try {
      setStatus('Reading mounted card files in read-only mode...');
      const result = await invoke<MountedFolderReport>('inspect_mounted_folder', { folderPath: selected });
      setMountedFiles(result);
      setStatus(`Read ${result.file_count.toLocaleString()} mounted files. No files were changed.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const detectRemovableDisks = async () => {
    setError(null);
    setDiskLoading(true);
    try {
      const disks = await invoke<RemovableDisk[]>('detect_removable_disks');
      setRemovableDisks(disks);
      setStatus(disks.length ? `Found ${disks.length} removable disk${disks.length === 1 ? '' : 's'}.` : 'No removable SD card or USB disk detected.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiskLoading(false);
    }
  };

  const probePartitionHeader = async (diskNumber: number, partitionNumber: number) => {
    setError(null);
    setProbeLoading(`${diskNumber}:${partitionNumber}`);
    try {
      const result = await invoke<PartitionProbe>('probe_partition_header', { diskNumber, partitionNumber });
      setPartitionProbe(result);
      setStatus(`Read ${result.bytes_read.toLocaleString()} bytes from Disk ${diskNumber}, partition ${partitionNumber}. No data was written.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProbeLoading(null);
    }
  };

  const probeFirstIndexedCluster = async (diskNumber: number, partitionNumber: number) => {
    const record = report?.records.find((item) => item.cluster_number > 0);
    if (!record) {
      setError('Load SDFileInfo.db first so FCM can use a recorded cluster reference.');
      return;
    }
    setError(null);
    setProbeLoading(`${diskNumber}:${partitionNumber}:cluster`);
    try {
      const result = await invoke<ClusterMappingReport>('probe_indexed_cluster', { diskNumber, partitionNumber, clusterNumber: record.cluster_number });
      setClusterReport(result);
      setStatus(`Read four 4 KB candidate samples for indexed cluster ${record.cluster_number}. No data was written.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProbeLoading(null);
    }
  };

  const uploadVideo = async () => {
    if (!video) return;
    setError(null);
    setUploadStatus('Preparing private video upload...');
    const supabase = getSupabaseClient();
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
        {activeView === 'sd-import' && <><div className="workspace-heading"><span>Evidence intake</span><h2>SD card files and partitions</h2><p>Detect the removable disk, load the camera index, then test only four candidate offsets for one indexed recording before choosing a vendor reader or image analysis.</p></div><section className="tool"><button type="button" onClick={() => void detectRemovableDisks()} disabled={diskLoading}><RefreshCw size={16} className={diskLoading ? 'is-spinning' : ''} /> Detect SD card partitions</button><button type="button" onClick={() => void inspectMountedFolder()}><HardDrive size={16} /> Browse mounted card files</button><button type="button" onClick={() => void inspectIndex()}><Database size={16} /> Choose SDFileInfo.db</button><p>{status}</p></section>{removableDisks.map((disk) => <section className="results" key={disk.disk_number}><h2>Disk {disk.disk_number}: {disk.friendly_name || 'Removable disk'}</h2><p>{formatBytes(disk.size_bytes)} · {disk.bus_type} · {disk.operational_status}</p><table><thead><tr><th>Partition</th><th>Size</th><th>Filesystem</th><th>Windows access</th><th>Read-only probe</th></tr></thead><tbody>{disk.partitions.map((partition) => <tr key={partition.partition_number}><td>{partition.partition_number}</td><td>{formatBytes(partition.size_bytes)}</td><td>{partition.filesystem || 'Unknown or proprietary'}</td><td>{partition.drive_letter ? `${partition.drive_letter}: mounted` : 'Not mounted'}</td><td>{!partition.drive_letter && <><button type="button" onClick={() => void probePartitionHeader(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null}>{probeLoading === `${disk.disk_number}:${partition.partition_number}` ? 'Probing...' : 'Probe header'}</button><button type="button" onClick={() => void probeFirstIndexedCluster(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null || !report}>{probeLoading === `${disk.disk_number}:${partition.partition_number}:cluster` ? 'Sampling...' : 'Test first index'}</button></>}</td></tr>)}</tbody></table>{disk.partitions.some((partition) => !partition.drive_letter) && <p className="mounted-note"><AlertTriangle size={15} /> Probes are read-only and bounded: the header reads 4 KB, while the index test reads four 4 KB samples. Do not format or repair an unmounted partition.</p>}</section>)}{partitionProbe && <section className="results"><h2>Partition header report</h2><p><strong>Disk {partitionProbe.disk_number}, partition {partitionProbe.partition_number}</strong> · offset {partitionProbe.offset_bytes.toLocaleString()} bytes · {partitionProbe.bytes_read.toLocaleString()} bytes read</p><p className="mounted-note">{partitionProbe.format_hint}</p><p className="hash">SHA-256: {partitionProbe.sha256}<br />First 32 bytes: {partitionProbe.signature}</p></section>}{clusterReport && <section className="results"><h2>Indexed cluster mapping report</h2><p>Disk {clusterReport.disk_number}, partition {clusterReport.partition_number} · index cluster {clusterReport.cluster_number}</p><table><thead><tr><th>Candidate block size</th><th>Absolute offset</th><th>Result</th></tr></thead><tbody>{clusterReport.samples.map((sample) => <tr key={sample.multiplier_bytes}><td>{sample.multiplier_bytes.toLocaleString()} bytes</td><td>{sample.absolute_offset_bytes.toLocaleString()} bytes</td><td>{sample.format_hint}</td></tr>)}</tbody></table><p className="hash">Each sample is 4 KB. Hashes and signatures remain available in the local report for validation; no video is exported at this stage.</p></section>}{mountedFiles && <section className="results"><div className="metrics"><Metric label="Mounted files" value={mountedFiles.file_count} /><Metric label="Total data" value={Math.round(mountedFiles.total_bytes / 1024 / 1024)} /><Metric label="File limit" value={mountedFiles.truncated ? 5000 : mountedFiles.file_count} /></div><p className="hash">Source: {mountedFiles.folder_path}</p><table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>{mountedFiles.files.map((file) => <tr key={file.relative_path}><td><FileText size={14} /> {file.relative_path}</td><td>{formatBytes(file.size_bytes)}</td></tr>)}</tbody></table></section>}</>}
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