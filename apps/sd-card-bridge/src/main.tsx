import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { AlertTriangle, Camera, Database, ExternalLink, FileText, HardDrive, LogOut, MonitorPlay, RefreshCw, Upload, Wifi } from 'lucide-react';
import { getSupabaseClient } from './lib/supabase';
import './styles.css';

const FCM_WEB_URL = 'https://field-compliance-manager-8hs8ed7et-iron-eagle-security.vercel.app';
const DAHUA_TOOLBOX_DOWNLOAD_URL = 'https://www.dahuasecurity.com/support/downloadCenter';

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

type SdCardAnalysis = {
  disks: RemovableDisk[];
  index_report: IndexReport | null;
  hidden_partition: RemovableDisk['partitions'][number] | null;
  cluster_report: ClusterMappingReport | null;
  summary: string;
};

type DhfsMetadataScan = {
  disk_number: number;
  partition_number: number;
  bytes_scanned: number;
  dhfs_marker_offsets: number[];
  non_zero_block_offsets: number[];
  truncated: boolean;
};

type DhfsHeaderReport = {
  disk_number: number;
  partition_number: number;
  headers: Array<{
    absolute_offset_bytes: number;
    sha256: string;
    ascii_preview: string;
    hex_preview: string;
  }>;
};

type DhfsDptReport = {
  disk_number: number;
  partition_number: number;
  dpt_header_offsets: number[];
  headers_identical: boolean;
  differing_byte_offsets: number[];
  non_zero_u32_fields: Array<{
    relative_offset_bytes: number;
    little_endian_u32: number;
    big_endian_u32: number;
  }>;
};

type ExportTool = {
  name: string;
  executable_path: string;
};

type DhfsConversionReport = {
  source_path: string;
  source_sha256: string;
  output_directory: string;
  exported: Array<{
    file_name: string;
    partition: number;
    descriptor: number;
    channel: number;
    start_time: string;
    end_time: string;
    bytes_written: number;
  }>;
};

type CachedClipReport = {
  cache_path: string;
  bytes: number;
  sha256: string;
  state: string;
};

type PhysicalDhfsRecording = {
  partition_number: number;
  descriptor: number;
  channel: number;
  start_time: string;
  end_time: string;
  fragment_count: number;
  bytes: number;
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
  const [activeView, setActiveView] = useState<'home' | 'sd-import' | 'sd-import-clean' | 'video-upload'>('home');
  const [mountedFiles, setMountedFiles] = useState<MountedFolderReport | null>(null);
  const [removableDisks, setRemovableDisks] = useState<RemovableDisk[]>([]);
  const [diskLoading, setDiskLoading] = useState(false);
  const [partitionProbe, setPartitionProbe] = useState<PartitionProbe | null>(null);
  const [probeLoading, setProbeLoading] = useState<string | null>(null);
  const [clusterReport, setClusterReport] = useState<ClusterMappingReport | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [dhfsScan, setDhfsScan] = useState<DhfsMetadataScan | null>(null);
  const [dhfsLoading, setDhfsLoading] = useState(false);
  const [dhfsHeaders, setDhfsHeaders] = useState<DhfsHeaderReport | null>(null);
  const [dhfsDpt, setDhfsDpt] = useState<DhfsDptReport | null>(null);
  const [exportTools, setExportTools] = useState<ExportTool[] | null>(null);
  const [toolDetectionLoading, setToolDetectionLoading] = useState(false);
  const [conversionReport, setConversionReport] = useState<DhfsConversionReport | null>(null);
  const [conversionLoading, setConversionLoading] = useState(false);
  const [imagingLoading, setImagingLoading] = useState(false);
  const [convertedVideoLoading, setConvertedVideoLoading] = useState<string | null>(null);
  const [cachedClip, setCachedClip] = useState<CachedClipReport | null>(null);
  const [physicalRecordings, setPhysicalRecordings] = useState<PhysicalDhfsRecording[]>([]);
  const [physicalRecordingsLoading, setPhysicalRecordingsLoading] = useState(false);

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
    setCachedClip(null);
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

  const analyseInsertedSdCard = async () => {
    setError(null);
    setAnalysisLoading(true);
    try {
      const result = await invoke<SdCardAnalysis>('analyse_inserted_sd_card');
      setRemovableDisks(result.disks);
      setReport(result.index_report);
      setClusterReport(result.cluster_report);
      setStatus(result.summary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnalysisLoading(false);
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

  const scanDhfsMetadata = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Detect the inserted SD card before scanning its DHFS metadata.');
      return;
    }
    setError(null);
    setDhfsLoading(true);
    try {
      const result = await invoke<DhfsMetadataScan>('scan_dhfs_metadata', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number });
      setDhfsScan(result);
      setStatus(`Scanned the first ${formatBytes(result.bytes_scanned)} of the DHFS partition. No video was copied or modified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDhfsLoading(false);
    }
  };

  const inspectDhfsHeaders = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Detect the inserted SD card before decoding DHFS headers.');
      return;
    }
    setError(null);
    setDhfsLoading(true);
    try {
      const result = await invoke<DhfsHeaderReport>('inspect_dhfs_headers', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number });
      setDhfsHeaders(result);
      setStatus(`Decoded ${result.headers.length} DHFS metadata headers. No video was copied or modified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDhfsLoading(false);
    }
  };

  const inspectDhfsDpt = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Detect the inserted SD card before comparing DHFS DPT metadata.');
      return;
    }
    setError(null);
    setDhfsLoading(true);
    try {
      const result = await invoke<DhfsDptReport>('inspect_dhfs_dpt', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number });
      setDhfsDpt(result);
      setStatus(`Compared ${result.dpt_header_offsets.length} redundant DHFS_DPT headers. No video was copied or modified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDhfsLoading(false);
    }
  };

  const detectDahuaExportTools = async () => {
    setError(null);
    setToolDetectionLoading(true);
    try {
      const tools = await invoke<ExportTool[]>('detect_dahua_export_tools');
      setExportTools(tools);
      setStatus(tools.length ? `Found ${tools.length} Dahua-compatible export tool${tools.length === 1 ? '' : 's'}.` : 'No Dahua-compatible export tool was found on this PC.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToolDetectionLoading(false);
    }
  };

  const convertDhfsImage = async () => {
    setError(null);
    const selectedImage = await open({
      title: 'Select a read-only DHFS disk or partition image',
      multiple: false,
      filters: [{ name: 'Disk image', extensions: ['dd', 'img', 'bin'] }],
    });
    if (typeof selectedImage !== 'string') return;
    const outputDirectory = await open({ title: 'Choose a folder for reconstructed H.264 recordings', directory: true, multiple: false });
    if (typeof outputDirectory !== 'string') return;
    setConversionLoading(true);
    setStatus('Converting DHFS recordings locally. The source image is read-only...');
    try {
      const result = await invoke<DhfsConversionReport>('convert_dhfs_image', {
        imagePath: selectedImage,
        outputDirectory,
      });
      setConversionReport(result);
      setStatus(`Converted ${result.exported.length} DHFS recording${result.exported.length === 1 ? '' : 's'} locally. Select the H.264 output in Video Upload.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('DHFS conversion did not complete.');
    } finally {
      setConversionLoading(false);
    }
  };

  const imageInsertedDhfsPartition = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Analyse the inserted SD card first so FCM can identify its DHFS partition.');
      return;
    }
    setError(null);
    const outputPath = await save({ title: 'Save DHFS image on the local computer (not the SD card)', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-dhfs-evidence.img', filters: [{ name: 'Disk image', extensions: ['img'] }] });
    if (!outputPath) return;
    setImagingLoading(true);
    setStatus('Creating a read-only image on the local computer. Keep the SD card connected; this may take a while...');
    try {
      const result = await invoke<{ bytes_copied: number; sha256: string; output_path: string }>('image_dhfs_partition', {
        diskNumber: disk.disk_number,
        partitionNumber: partition.partition_number,
        outputPath,
      });
      setStatus(`Created ${Math.round(result.bytes_copied / 1024 / 1024 / 1024)} GB read-only image. SHA-256: ${result.sha256}. Run the built-in converter on this image.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImagingLoading(false);
    }
  };

  const listPhysicalDhfsRecordings = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Analyse the inserted SD card first so FCM can identify its DHFS partition.');
      return;
    }
    setPhysicalRecordingsLoading(true);
    setError(null);
    try {
      const recordings = await invoke<PhysicalDhfsRecording[]>('list_dhfs_partition_recordings', {
        diskNumber: disk.disk_number,
        partitionNumber: partition.partition_number,
      });
      setPhysicalRecordings(recordings);
      setStatus(`Read ${recordings.length.toLocaleString()} normal DHFS recordings directly from the card. No full image was created.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPhysicalRecordingsLoading(false);
    }
  };

  const selectConvertedVideo = async (exported: DhfsConversionReport['exported'][number]) => {
    if (!conversionReport) return;
    if (exported.bytes_written > 524288000) {
      setError('This converted clip exceeds the 500 MB upload limit. Select a shorter recording.');
      return;
    }
    setConvertedVideoLoading(exported.file_name);
    setError(null);
    try {
      if (cachedClip) await invoke('clear_cached_clip', { cachePath: cachedClip.cache_path });
      const cacheResult = await invoke<CachedClipReport>('cache_video_clip', {
        sourcePath: `${conversionReport.output_directory.replace(/[\\/]$/, '')}/${exported.file_name}`,
        cacheDirectory: `${conversionReport.output_directory.replace(/[\\/]$/, '')}/fcm-cache`,
        cacheName: exported.file_name,
      });
      const bytes = await readFile(cacheResult.cache_path);
      setCachedClip(cacheResult);
      setVideo(new File([bytes], exported.file_name, { type: 'video/h264' }));
      setActiveView('video-upload');
      setUploadStatus(`Clip cached and verified (${cacheResult.sha256.slice(0, 12)}...). Review it, then upload it to Bob.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConvertedVideoLoading(null);
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
      if (cachedClip) {
        await invoke('clear_cached_clip', { cachePath: cachedClip.cache_path });
        setCachedClip(null);
      }
      setVideo(null);
    } catch (cause) {
      await supabase.storage.from('bob-uploads').remove([storagePath]);
      setError(cause instanceof Error ? cause.message : 'Video upload did not complete.');
      setUploadStatus(null);
    }
  };

  return <main className="desktop-companion">
    <header className="companion-header">
      <div className="companion-brand"><span className="companion-brand-mark" aria-hidden="true"><Camera size={24} /></span><div><span>Iron Eagle Security</span><h1>FCM Desktop</h1></div></div>
      {signedInAs ? <div className="companion-session"><span><Wifi size={14} /> Connected as {signedInAs}</span><button type="button" className="icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={17} /></button></div> : <form className="sign-in-form" onSubmit={(event) => void signIn(event)}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" required /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" required /><button type="submit">Sign in</button></form>}
    </header>
    <div className="companion-layout">
      <nav className="companion-nav" aria-label="FCM Desktop navigation">
        <button type="button" className={activeView === 'home' ? 'is-active' : ''} onClick={() => setActiveView('home')}><MonitorPlay size={18} /> Desktop home</button>
        <button type="button" className={activeView === 'sd-import-clean' ? 'is-active' : ''} onClick={() => setActiveView('sd-import-clean')}><HardDrive size={18} /> SD card import</button>
        <button type="button" onClick={() => void convertDhfsImage()} disabled={conversionLoading}><Database size={18} /> {conversionLoading ? 'Converting DHFS...' : 'Built-in DHFS converter'}</button>
        <button type="button" onClick={() => void imageInsertedDhfsPartition()} disabled={imagingLoading}><HardDrive size={18} /> {imagingLoading ? 'Imaging DHFS card...' : 'Image inserted DHFS card'}</button>
        <button type="button" onClick={() => void listPhysicalDhfsRecordings()} disabled={physicalRecordingsLoading}><Database size={18} /> {physicalRecordingsLoading ? 'Reading card recordings...' : 'Read card recordings directly'}</button>
        <button type="button" className={activeView === 'video-upload' ? 'is-active' : ''} onClick={() => setActiveView('video-upload')}><Upload size={18} /> Video upload</button>
        <a href={FCM_WEB_URL} target="_blank" rel="noreferrer"><ExternalLink size={18} /> FCM web portal</a>
      </nav>
      <section className="companion-workspace">
        {error && <div className="companion-error" role="alert">{error}</div>}
        {!signedInAs && <section className="connection-notice"><strong>Sign in to begin</strong><span>Use your authorised FCM account. Desktop processing is local; evidence, approvals, and results remain centrally governed.</span></section>}
        {activeView === 'sd-import-clean' && <><div className="workspace-heading"><span>SD evidence intake</span><h2>Import Dahua camera footage</h2><p>FCM identifies the inserted DHFS card and hands selected recordings to an approved exporter. The SD card is never modified.</p></div><section className="tool"><button type="button" onClick={() => void analyseInsertedSdCard()} disabled={analysisLoading}><RefreshCw size={16} className={analysisLoading ? 'is-spinning' : ''} /> {analysisLoading ? 'Analysing card...' : 'Analyse inserted SD card'}</button><p>{status}</p></section>{report && <section className="results"><h2>Dahua DHFS card detected</h2><div className="metrics"><Metric label="Indexed recordings" value={report.valid_timestamped_record_count} /><Metric label="Media partition" value={removableDisks.flatMap((disk) => disk.partitions).filter((partition) => !partition.drive_letter).map((partition) => Math.round(partition.size_bytes / 1024 / 1024 / 1024)).join(', ') || 'Unknown'} suffix=" GB" /><Metric label="Card access" value="Read-only" /></div><p className="mounted-note">The recording partition uses Dahua DHFS 4.1. FCM does not decode or alter proprietary footage directly.</p></section>}<section className="results"><h2>Export selected recordings</h2><p>Use Dahua SmartPlayer/Toolbox or a licensed DHFS export tool to export the chosen time range as MP4 or AVI. Then open Video Upload to send it to the VPS inference queue.</p><button type="button" onClick={() => void detectDahuaExportTools()} disabled={toolDetectionLoading}>{toolDetectionLoading ? 'Checking installed tools...' : 'Find installed Dahua export tools'}</button>{exportTools !== null && (exportTools.length ? <ul className="export-tool-list">{exportTools.map((tool) => <li key={tool.executable_path}><strong>{tool.name}</strong><span>{tool.executable_path}</span></li>)}</ul> : <div className="export-tool-actions"><p className="mounted-note">No compatible exporter was found on this PC.</p><a href={DAHUA_TOOLBOX_DOWNLOAD_URL} target="_blank" rel="noreferrer">Get Dahua Toolbox</a></div>)}</section></>}
        {activeView === 'sd-import' && removableDisks.some((disk) => disk.partitions.some((partition) => !partition.drive_letter)) && <section className="tool"><button type="button" onClick={() => void inspectDhfsHeaders()} disabled={dhfsLoading || analysisLoading}><Database size={16} /> {dhfsLoading ? 'Decoding DHFS...' : 'Decode DHFS headers'}</button><p>Reads only DHFS-marked 4 KB metadata headers from the first 64 KB of the unmounted partition.</p></section>}
        {activeView === 'sd-import' && dhfsHeaders && <section className="results"><h2>DHFS header decode</h2><p>Disk {dhfsHeaders.disk_number}, partition {dhfsHeaders.partition_number} · {dhfsHeaders.headers.length} metadata headers decoded</p><table><thead><tr><th>Offset</th><th>ASCII preview</th><th>SHA-256</th></tr></thead><tbody>{dhfsHeaders.headers.map((header) => <tr key={header.absolute_offset_bytes}><td>{header.absolute_offset_bytes.toLocaleString()}</td><td className="hash">{header.ascii_preview}</td><td className="hash">{header.sha256}</td></tr>)}</tbody></table></section>}
        {activeView === 'sd-import' && removableDisks.some((disk) => disk.partitions.some((partition) => !partition.drive_letter)) && <section className="tool"><button type="button" onClick={() => void inspectDhfsDpt()} disabled={dhfsLoading || analysisLoading}><Database size={16} /> {dhfsLoading ? 'Comparing DPT...' : 'Compare DHFS DPT copies'}</button><p>Compares only the redundant `DHFS_DPT:3.0` metadata headers in the first 64 KB.</p></section>}
        {activeView === 'sd-import' && dhfsDpt && <section className="results"><h2>DHFS DPT comparison</h2><p>{dhfsDpt.headers_identical ? 'The redundant DPT headers are byte-identical.' : `${dhfsDpt.differing_byte_offsets.length} differing byte offsets were found.`}</p><p className="hash">DPT header offsets: {dhfsDpt.dpt_header_offsets.join(', ')}</p><table><thead><tr><th>Relative field offset</th><th>Little-endian value</th><th>Big-endian value</th></tr></thead><tbody>{dhfsDpt.non_zero_u32_fields.map((field) => <tr key={field.relative_offset_bytes}><td>{field.relative_offset_bytes}</td><td>{field.little_endian_u32}</td><td>{field.big_endian_u32}</td></tr>)}</tbody></table></section>}
        {activeView === 'sd-import' && <section className="results"><h2>Dahua export handoff</h2><p>The card is DHFS 4.1. Use a DHFS-compatible viewer to export a selected recording as MP4/AVI, then upload it through FCM Desktop for VPS inference.</p><button type="button" onClick={() => void detectDahuaExportTools()} disabled={toolDetectionLoading}>{toolDetectionLoading ? 'Checking installed tools...' : 'Find installed Dahua export tools'}</button>{exportTools !== null && <>{exportTools.length ? <ul className="export-tool-list">{exportTools.map((tool) => <li key={tool.executable_path}><strong>{tool.name}</strong><span>{tool.executable_path}</span></li>)}</ul> : <p className="mounted-note">Install the official Dahua SmartPlayer/Toolbox or use a licensed DHFS forensic export tool. FCM does not replace their proprietary decoder.</p>}</>}</section>}
        {activeView === 'home' && <><div className="workspace-heading"><span>Local operations</span><h2>FCM desktop workspace</h2><p>Use local hardware and large-file tools here. Open the FCM web portal for live work queues, formal review, reporting, and approvals.</p></div><div className="capability-grid"><Capability icon={<HardDrive size={23} />} title="SD card import" detail="Inspect copied camera indexes and prepare evidence for review." action="Open importer" onClick={() => setActiveView('sd-import-clean')} /><Capability icon={<Camera size={23} />} title="Camera evidence" detail="Upload exported footage and queue VPS motion, ALPR, and face analysis." action="Upload video" onClick={() => setActiveView('video-upload')} /><Capability icon={<Database size={23} />} title="Operations portal" detail="Open FCM web for CCTV Review, Parking, Freedom Camping, and approvals." action="Open FCM web" onClick={() => window.open(FCM_WEB_URL, '_blank', 'noopener,noreferrer')} /></div><section className="read-only-notice"><strong>Current local access</strong><span>This release never writes to an SD card or reads raw physical disks. It works with copied evidence while the vendor storage format is validated.</span></section></>}
        {activeView === 'sd-import' && <><div className="workspace-heading"><span>Evidence intake</span><h2>SD card files and partitions</h2><p>Analyse the inserted card to find the camera index, hidden recording partition, and a bounded mapping sample automatically.</p></div><section className="tool"><button type="button" onClick={() => void analyseInsertedSdCard()} disabled={analysisLoading}><RefreshCw size={16} className={analysisLoading ? 'is-spinning' : ''} /> Analyse inserted SD card</button><button type="button" onClick={() => void scanDhfsMetadata()} disabled={dhfsLoading || analysisLoading}><Database size={16} /> {dhfsLoading ? 'Scanning DHFS...' : 'Scan DHFS metadata'}</button><button type="button" onClick={() => void detectRemovableDisks()} disabled={diskLoading || analysisLoading}><HardDrive size={16} /> Detect partitions</button><button type="button" onClick={() => void inspectMountedFolder()}><FileText size={16} /> Browse mounted files</button><button type="button" onClick={() => void inspectIndex()}><Database size={16} /> Choose SDFileInfo.db</button><p>{status}</p></section>{removableDisks.map((disk) => <section className="results" key={disk.disk_number}><h2>Disk {disk.disk_number}: {disk.friendly_name || 'Removable disk'}</h2><p>{formatBytes(disk.size_bytes)} · {disk.bus_type} · {disk.operational_status}</p><table><thead><tr><th>Partition</th><th>Size</th><th>Filesystem</th><th>Windows access</th><th>Read-only probe</th></tr></thead><tbody>{disk.partitions.map((partition) => <tr key={partition.partition_number}><td>{partition.partition_number}</td><td>{formatBytes(partition.size_bytes)}</td><td>{partition.filesystem || 'Unknown or proprietary'}</td><td>{partition.drive_letter ? `${partition.drive_letter}: mounted` : 'Not mounted'}</td><td>{!partition.drive_letter && <><button type="button" onClick={() => void probePartitionHeader(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null}>{probeLoading === `${disk.disk_number}:${partition.partition_number}` ? 'Probing...' : 'Probe header'}</button><button type="button" onClick={() => void probeFirstIndexedCluster(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null || !report}>{probeLoading === `${disk.disk_number}:${partition.partition_number}:cluster` ? 'Sampling...' : 'Test first index'}</button></>}</td></tr>)}</tbody></table>{disk.partitions.some((partition) => !partition.drive_letter) && <p className="mounted-note"><AlertTriangle size={15} /> Analysis and probes are read-only. Do not format or repair an unmounted partition.</p>}</section>)}{dhfsScan && <section className="results"><h2>DHFS metadata reconnaissance</h2><p>Disk {dhfsScan.disk_number}, partition {dhfsScan.partition_number} · scanned {formatBytes(dhfsScan.bytes_scanned)}{dhfsScan.truncated ? ' (bounded first 16 MB)' : ''}</p><p className="mounted-note">DHFS markers found: {dhfsScan.dhfs_marker_offsets.length}. Non-zero 4 KB metadata blocks reported: {dhfsScan.non_zero_block_offsets.length}.</p><p className="hash">DHFS marker offsets: {dhfsScan.dhfs_marker_offsets.length ? dhfsScan.dhfs_marker_offsets.join(', ') : 'none beyond the header'}<br />Non-zero block offsets: {dhfsScan.non_zero_block_offsets.length ? dhfsScan.non_zero_block_offsets.join(', ') : 'none'}</p></section>}{partitionProbe && <section className="results"><h2>Partition header report</h2><p><strong>Disk {partitionProbe.disk_number}, partition {partitionProbe.partition_number}</strong> · offset {partitionProbe.offset_bytes.toLocaleString()} bytes · {partitionProbe.bytes_read.toLocaleString()} bytes read</p><p className="mounted-note">{partitionProbe.format_hint}</p><p className="hash">SHA-256: {partitionProbe.sha256}<br />First 32 bytes: {partitionProbe.signature}</p></section>}{clusterReport && <section className="results"><h2>Indexed cluster mapping report</h2><p>Disk {clusterReport.disk_number}, partition {clusterReport.partition_number} · index cluster {clusterReport.cluster_number}</p><table><thead><tr><th>Candidate block size</th><th>Absolute offset</th><th>Result</th></tr></thead><tbody>{clusterReport.samples.map((sample) => <tr key={sample.multiplier_bytes}><td>{sample.multiplier_bytes.toLocaleString()} bytes</td><td>{sample.absolute_offset_bytes.toLocaleString()} bytes</td><td>{sample.format_hint}</td></tr>)}</tbody></table><p className="hash">Each sample is 4 KB. No video is exported at this stage.</p></section>}{mountedFiles && <section className="results"><div className="metrics"><Metric label="Mounted files" value={mountedFiles.file_count} /><Metric label="Total data" value={Math.round(mountedFiles.total_bytes / 1024 / 1024)} /><Metric label="File limit" value={mountedFiles.truncated ? 5000 : mountedFiles.file_count} /></div><p className="hash">Source: {mountedFiles.folder_path}</p><table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>{mountedFiles.files.map((file) => <tr key={file.relative_path}><td><FileText size={14} /> {file.relative_path}</td><td>{formatBytes(file.size_bytes)}</td></tr>)}</tbody></table></section>}</>}
        {activeView === 'video-upload' && <><div className="workspace-heading"><span>Evidence intake</span><h2>Upload camera video</h2><p>Select converted H.264 or exported MP4, MOV, AVI, or MKV. FCM stores it privately and queues VPS inference for CCTV Review.</p></div><section className="tool upload-tool"><input type="file" accept="video/*,.avi,.mkv,.h264" disabled={!signedInAs} onChange={(event) => setVideo(event.target.files?.[0] ?? null)} /><button type="button" onClick={() => void uploadVideo()} disabled={!signedInAs || !video}><Upload size={16} /> Upload to CCTV Review</button>{video && <p>Selected: {video.name} ({Math.ceil(video.size / 1024 / 1024)} MB)</p>}{uploadStatus && <p>{uploadStatus}</p>}</section></>}
    {conversionReport && <section className="results"><h2>Converted DHFS recordings</h2><p className="hash">Source SHA-256: {conversionReport.source_sha256}</p><ul className="export-tool-list">{conversionReport.exported.map((exported) => <li key={exported.file_name}><strong>{exported.start_time} · Camera {exported.channel}</strong><span>{exported.file_name} · {formatBytes(exported.bytes_written)}</span><button type="button" onClick={() => void selectConvertedVideo(exported)} disabled={convertedVideoLoading !== null}>{convertedVideoLoading === exported.file_name ? 'Loading clip...' : 'Select clip for Bob'}</button></li>)}</ul></section>}
    {activeView === 'sd-import' && report && <section className="results">
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

function Metric({ label, value, suffix = '' }: { label: string; value: number | string; suffix?: string }) {
  return <div><strong>{value}{suffix}</strong><span>{label}</span></div>;
}

function Capability({ icon, title, detail, action, onClick }: { icon: React.ReactNode; title: string; detail: string; action: string; onClick: () => void }) {
  return <section className="capability"><span>{icon}</span><h3>{title}</h3><p>{detail}</p><button type="button" onClick={onClick}>{action}</button></section>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);