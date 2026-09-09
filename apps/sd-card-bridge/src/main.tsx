import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Upload as TusUpload } from 'tus-js-client';
import { AlertTriangle, Camera, Database, ExternalLink, FileText, HardDrive, LogOut, MonitorPlay, RefreshCw, ShieldCheck, Upload, Wifi } from 'lucide-react';
import { FCM_SUPABASE_URL, getSupabaseClient, SUPABASE_PUBLISHABLE_KEY } from './lib/supabase';
import './styles.css';

const FCM_WEB_URL = 'https://fcmanager.co.nz';
const FCM_CCTV_REVIEW_URL = `${FCM_WEB_URL}/admin/field-ops?area=cctv-review`;
const DAHUA_TOOLBOX_DOWNLOAD_URL = 'https://www.dahuasecurity.com/support/downloadCenter';
const MAX_BOB_UPLOAD_BYTES = 128 * 1024 * 1024 * 1024;
const RESUMABLE_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;

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

type DhfsPartitionTableReport = {
  disk_number: number;
  partition_number: number;
  dpt_marker_absolute_offset: number;
  table_start_absolute_offset: number;
  entries: Array<{
    index: number;
    partition_offset: number;
    superblock_offset: number;
    superblock_absolute_offset: number;
    block_size: number;
    fragment_size_blocks: number;
    descriptor_offset_blocks: number;
    video_offset_blocks: number;
    descriptor_count: number;
  }>;
  stopped_reason: string;
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
    content_type: string;
    starts_with_nal_marker: boolean;
    codec: string;
    stream_start_offset: number;
  }>;
};

type CachedClipReport = {
  cache_path: string;
  bytes: number;
  sha256: string;
  state: string;
  content_type: string;
  channel?: number;
  start_time?: string;
  end_time?: string;
  starts_with_nal_marker?: boolean;
  codec: string;
  stream_start_offset: number;
};

type PhysicalDhfsRecording = {
  partition_number: number;
  dhfs_partition_index: number;
  descriptor: number;
  channel: number;
  start_time: string;
  end_time: string;
  fragment_count: number;
  bytes: number;
};

type DesktopReviewBatchMetadata = {
  batch_id: string;
  clip_index: number;
  clip_total: number;
  channel: number;
  start_time: string;
  end_time: string;
  fragment_count: number;
  source_bytes: number;
  cache_sha256: string;
};

type AutoProcessStage = 'idle' | 'analysing' | 'enumerating' | 'caching' | 'uploading' | 'registered' | 'paused' | 'failed';

const AUTO_PROCESS_ACTIVE_STAGES: AutoProcessStage[] = ['analysing', 'enumerating', 'caching', 'uploading'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function cacheStatusMessage(result: CachedClipReport): string {
  const base = `Clip cached and verified (${result.sha256.slice(0, 12)}...).`;
  if (result.starts_with_nal_marker === false) {
    return `${base} Warning: the extracted bytes do not start on a recognised H.264/H.265 frame boundary; review the clip carefully before uploading.`;
  }
  if (result.codec === 'unknown') {
    return `${base} Codec was not classified locally; the original DHFS elementary stream is preserved for central decoder analysis.`;
  }
  return `${base} Review it, then upload it to Bob.`;
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

function estimateRemainingSeconds(startedAt: number | null, progress: number, now: number): number | null {
  if (!startedAt || progress <= 2 || progress >= 100) return null;
  const elapsed = (now - startedAt) / 1000;
  const projectedTotal = elapsed / (progress / 100);
  return Math.max(0, projectedTotal - elapsed);
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
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<'home' | 'sd-import' | 'sd-import-clean' | 'cctv-review' | 'video-upload'>('home');
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
  const [partitionTable, setPartitionTable] = useState<DhfsPartitionTableReport | null>(null);
  const [exportTools, setExportTools] = useState<ExportTool[] | null>(null);
  const [toolDetectionLoading, setToolDetectionLoading] = useState(false);
  const [conversionReport, setConversionReport] = useState<DhfsConversionReport | null>(null);
  const [conversionLoading, setConversionLoading] = useState(false);
  const [imagingLoading, setImagingLoading] = useState(false);
  const [convertedVideoLoading, setConvertedVideoLoading] = useState<string | null>(null);
  const [cachedClip, setCachedClip] = useState<CachedClipReport | null>(null);
  const [physicalRecordings, setPhysicalRecordings] = useState<PhysicalDhfsRecording[]>([]);
  const [physicalRecordingsLoading, setPhysicalRecordingsLoading] = useState(false);
  const [cardExtractionLoading, setCardExtractionLoading] = useState<string | null>(null);
  const [autoStage, setAutoStage] = useState<AutoProcessStage>('idle');
  const [autoProgress, setAutoProgress] = useState(0);
  const [autoMessage, setAutoMessage] = useState('Ready to process every uploadable recording on the inserted SD card.');
  const [autoStartedAt, setAutoStartedAt] = useState<number | null>(null);
  const [autoClipIndex, setAutoClipIndex] = useState(0);
  const [autoClipTotal, setAutoClipTotal] = useState(0);
  const [autoSucceeded, setAutoSucceeded] = useState(0);
  const [autoFailed, setAutoFailed] = useState(0);
  const [clockTick, setClockTick] = useState(Date.now());
  const pauseRequested = useRef(false);

  useEffect(() => {
    if (!AUTO_PROCESS_ACTIVE_STAGES.includes(autoStage)) return;
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [autoStage]);

  const autoElapsedSeconds = autoStartedAt ? (clockTick - autoStartedAt) / 1000 : 0;
  const autoRemainingSeconds = estimateRemainingSeconds(autoStartedAt, autoProgress, clockTick);

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
    setUploadProgress(null);
    setCachedClip(null);
  };

  const openExternal = async (url: string) => {
    setError(null);
    try {
      await openUrl(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the external page.');
    }
  };

  const copyExternalLink = async (url: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setStatus('CCTV review link copied. Paste it into your browser if the Open button is blocked by Windows policy.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not copy the review link.');
    }
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

  const diagnosePartitionTable = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Detect the inserted SD card before diagnosing the DHFS partition table.');
      return;
    }
    setError(null);
    setDhfsLoading(true);
    try {
      const result = await invoke<DhfsPartitionTableReport>('diagnose_dhfs_partition_table', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number });
      setPartitionTable(result);
      setStatus(`Parsed ${result.entries.length} DHFS partition-table entries (${result.stopped_reason}). No video was copied or modified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDhfsLoading(false);
    }
  };

  const exportDiagnosticBytes = async () => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
    if (!disk || !partition) {
      setError('Detect the inserted SD card before exporting diagnostic bytes.');
      return;
    }
    setError(null);
    const outputPath = await save({ title: 'Save a small (1 MB) raw diagnostic byte range for exact review', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-dhfs-diagnostic-bytes.bin', filters: [{ name: 'Raw bytes', extensions: ['bin'] }] });
    if (!outputPath) return;
    setDhfsLoading(true);
    try {
      const bytesWritten = await invoke<number>('export_dhfs_diagnostic_bytes', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number, outputPath });
      setStatus(`Wrote ${formatBytes(bytesWritten)} of raw partition-start bytes to ${outputPath}. Attach that file directly for exact byte-level review.`);
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
    const outputPath = await save({ title: 'Save DHFS image on the internal hard drive or another external drive (not this SD card)', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-dhfs-evidence.img', filters: [{ name: 'Disk image', extensions: ['img'] }] });
    if (!outputPath) return;
    setImagingLoading(true);
    setStatus('Checking free space on the chosen drive...');
    try {
      const space = await invoke<{ drive: string; free_bytes: number; sufficient: boolean }>('check_destination_free_space', {
        outputPath,
        requiredBytes: partition.size_bytes,
      });
      if (!space.sufficient) {
        throw new Error(`Drive ${space.drive} only has ${Math.round(space.free_bytes / 1024 / 1024 / 1024)} GB free. Choose the internal hard drive or another external drive with at least ${Math.round(partition.size_bytes / 1024 / 1024 / 1024)} GB free.`);
      }
      setStatus(`Creating a read-only image on ${space.drive}. Keep the SD card connected; this may take a while...`);
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

  const extractCardRecordingToCache = async (recording: PhysicalDhfsRecording) => {
    const disk = removableDisks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
    if (!disk) {
      setError('Analyse the inserted SD card first so FCM can identify its DHFS partition.');
      return;
    }
    if (recording.bytes > MAX_BOB_UPLOAD_BYTES) {
      setError('This recording exceeds the 128 GB upload limit. Select a shorter recording.');
      return;
    }
    const recordingKey = `${recording.dhfs_partition_index}-${recording.descriptor}`;
    setCardExtractionLoading(recordingKey);
    setError(null);
    try {
      if (cachedClip) await invoke('clear_cached_clip', { cachePath: cachedClip.cache_path });
      setStatus('Reading the selected recording directly from the card. Keep it connected...');
      const cacheResult = await invoke<CachedClipReport>('extract_dhfs_recording_to_cache', {
        diskNumber: disk.disk_number,
        partitionNumber: recording.partition_number,
        dhfsPartitionIndex: recording.dhfs_partition_index,
        descriptorIndex: recording.descriptor,
        cacheDirectory: 'C:\\Users\\Public\\Documents\\fcm-cache',
      });
      const bytes = await readFile(cacheResult.cache_path);
      setCachedClip(cacheResult);
      const fileName = cacheResult.cache_path.replace(/^.*[\\/]/, '');
      setVideo(new File([bytes], fileName, { type: cacheResult.content_type }));
      setActiveView('video-upload');
      setUploadStatus(cacheStatusMessage(cacheResult));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCardExtractionLoading(null);
    }
  };

  const selectConvertedVideo = async (exported: DhfsConversionReport['exported'][number]) => {
    if (!conversionReport) return;
    if (exported.bytes_written > MAX_BOB_UPLOAD_BYTES) {
      setError('This converted clip exceeds the 128 GB upload limit. Select a shorter recording.');
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
      setVideo(new File([bytes], exported.file_name, { type: exported.content_type }));
      setActiveView('video-upload');
      setUploadStatus(cacheStatusMessage(cacheResult));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConvertedVideoLoading(null);
    }
  };

  const uploadPreparedVideo = async (file: File, preserveCachedClip = false, onUploadProgress?: (progress: number | null) => void, reviewBatch?: DesktopReviewBatchMetadata): Promise<boolean> => {
    if (file.size <= 0 || file.size > MAX_BOB_UPLOAD_BYTES) {
      setError('This file is empty or exceeds the 128 GB upload limit.');
      return false;
    }
    setError(null);
    setUploadStatus('Preparing private video upload...');
    setUploadProgress(0);
    const supabase = getSupabaseClient();
    const { data: sessionData } = await supabase.auth.getSession();
    const user = sessionData.session?.user;
    if (!user) {
      setError('Sign in before uploading a video.');
      setUploadStatus(null);
      return false;
    }
    const attachmentId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'desktop-export.mp4';
    const storagePath = `desktop/${user.id}/${attachmentId}-${safeName}`;
    try {
      if (file.size > RESUMABLE_UPLOAD_THRESHOLD) {
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) throw new Error('Your session expired before the upload could start.');
        await new Promise<void>((resolve, reject) => {
          const upload = new TusUpload(file, {
            endpoint: `${FCM_SUPABASE_URL}/storage/v1/upload/resumable`,
            retryDelays: [0, 1000, 3000, 5000],
            chunkSize: RESUMABLE_CHUNK_BYTES,
            uploadDataDuringCreation: true,
            headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}`, 'x-upsert': 'false' },
            metadata: { bucketName: 'bob-uploads', objectName: storagePath, contentType: file.type || 'application/octet-stream', cacheControl: '3600' },
            onError: reject,
            onProgress: (bytesSent, bytesTotal) => {
              const progress = bytesTotal > 0 ? Math.round((bytesSent / bytesTotal) * 100) : null;
              setUploadProgress(progress);
              setUploadStatus(progress === null ? 'Uploading private video...' : `Uploading private video... ${progress}%`);
              onUploadProgress?.(progress);
            },
            onSuccess: () => resolve(),
          });
          upload.start();
        });
      } else {
        setUploadProgress(null);
        onUploadProgress?.(100);
        const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (uploadError) throw uploadError;
      }
      setUploadStatus(file.type.startsWith('video/') ? 'Registering evidence and starting hybrid CCTV inference...' : 'Registering private evidence for Bob...');
      const { data, error: registerError } = await supabase.functions.invoke('register-desktop-video-import', {
        body: {
          attachment_id: attachmentId,
          storage_path: storagePath,
          file_name: file.name,
          file_type: file.type || 'video/mp4',
          file_size_bytes: file.size,
          desktop_review_batch: reviewBatch ?? null,
        },
      });
      if (registerError) {
        // supabase-js's default FunctionsHttpError message is a generic "non-2xx status code";
        // the real reason is in the response body our own edge function returned.
        const context = (registerError as { context?: unknown }).context;
        if (context instanceof Response) {
          const body = await context.clone().json().catch(() => null);
          throw new Error(body?.error || registerError.message);
        }
        throw registerError;
      }
      setUploadStatus(data?.inference_job_id ? `Uploaded. Hybrid inference job ${String(data.inference_job_id).slice(0, 8)} is queued for CCTV Review. GPU inference is preferred; VPS inference remains the fallback.` : 'Uploaded to private Bob storage for review.');
      setUploadProgress(100);
      if (cachedClip && !preserveCachedClip) {
        await invoke('clear_cached_clip', { cachePath: cachedClip.cache_path });
        setCachedClip(null);
      }
      setVideo(null);
      return true;
    } catch (cause) {
      await supabase.storage.from('bob-uploads').remove([storagePath]);
      setError(cause instanceof Error ? cause.message : 'Video upload did not complete.');
      setUploadStatus(null);
      setUploadProgress(null);
      return false;
    }
  };

  const uploadVideo = async () => {
    if (!video) return;
    await uploadPreparedVideo(video);
  };

  const pauseAutoProcess = () => {
    pauseRequested.current = true;
    setAutoStage('paused');
    setAutoMessage('Pause requested. The current read or upload will finish, then the workflow will stop before the next step.');
  };

  const restartAutoProcess = () => {
    pauseRequested.current = false;
    setAutoStage('idle');
    setAutoProgress(0);
    setAutoStartedAt(null);
    setAutoClipIndex(0);
    setAutoClipTotal(0);
    setAutoSucceeded(0);
    setAutoFailed(0);
    setAutoMessage('Ready to process every uploadable recording on the inserted SD card.');
  };

  const openCachedClip = async () => {
    if (!cachedClip) return;
    await openPath(cachedClip.cache_path).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open cached clip.'));
  };

  const revealCachedClip = async () => {
    if (!cachedClip) return;
    await revealItemInDir(cachedClip.cache_path).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not reveal cached clip.'));
  };

  const processSdCardReviewBatch = async () => {
    const stopIfPaused = () => {
      if (!pauseRequested.current) return false;
      setAutoStage('paused');
      setAutoMessage('Paused. Restart when you are ready to continue. Already queued recordings remain in CCTV Review.');
      return true;
    };
    const setBatchProgress = (clipIndex: number, clipFraction: number, clipTotal: number) => {
      const progress = clipTotal > 0 ? ((clipIndex + clipFraction) / clipTotal) * 100 : 0;
      setAutoProgress(Math.max(0, Math.min(99, Math.round(progress))));
    };
    try {
      pauseRequested.current = false;
      setAutoStartedAt(Date.now());
      setClockTick(Date.now());
      setAutoClipIndex(0);
      setAutoClipTotal(0);
      setAutoSucceeded(0);
      setAutoFailed(0);
      setError(null);
      setAutoStage('analysing');
      setAutoProgress(2);
      setAutoMessage('Analysing the inserted SD card.');
      const analysis = await invoke<SdCardAnalysis>('analyse_inserted_sd_card');
      setRemovableDisks(analysis.disks);
      setReport(analysis.index_report);
      setClusterReport(analysis.cluster_report);
      setStatus(analysis.summary);
      if (stopIfPaused()) return;
      const disk = analysis.disks.find((item) => item.partitions.some((partition) => !partition.drive_letter));
      const partition = disk?.partitions.filter((item) => !item.drive_letter).sort((left, right) => right.size_bytes - left.size_bytes)[0];
      if (!disk || !partition) throw new Error('No readable DHFS recording partition was found.');
      setAutoStage('enumerating');
      setAutoProgress(5);
      setAutoMessage('Reading every recording on the card.');
      const recordings = await invoke<PhysicalDhfsRecording[]>('list_dhfs_partition_recordings', { diskNumber: disk.disk_number, partitionNumber: partition.partition_number });
      setPhysicalRecordings(recordings);
      const uploadable = recordings.filter((item) => item.bytes > 0 && item.bytes <= MAX_BOB_UPLOAD_BYTES);
      setAutoClipTotal(uploadable.length);
      if (!uploadable.length) throw new Error('No uploadable recordings were found on this card.');
      if (stopIfPaused()) return;
      const batchId = crypto.randomUUID();
      let succeeded = 0;
      let failed = 0;
      for (let index = 0; index < uploadable.length; index += 1) {
        const recording = uploadable[index];
        setAutoClipIndex(index + 1);
        setAutoStage('caching');
        setBatchProgress(index, 0.15, uploadable.length);
        setAutoMessage(`Caching clip ${index + 1} of ${uploadable.length}: channel ${recording.channel}, ${recording.start_time} to ${recording.end_time}.`);
        try {
          const cacheResult = await invoke<CachedClipReport>('extract_dhfs_recording_to_cache', {
            diskNumber: disk.disk_number,
            partitionNumber: recording.partition_number,
            dhfsPartitionIndex: recording.dhfs_partition_index,
            descriptorIndex: recording.descriptor,
            cacheDirectory: 'C:\\Users\\Public\\Documents\\fcm-cache',
          });
          const bytes = await readFile(cacheResult.cache_path);
          const fileName = cacheResult.cache_path.replace(/^.*[\\/]/, '');
          const prepared = new File([bytes], fileName, { type: cacheResult.content_type });
          setCachedClip(cacheResult);
          setVideo(prepared);
          if (stopIfPaused()) return;
          setAutoStage('uploading');
          setBatchProgress(index, 0.55, uploadable.length);
          setAutoMessage(`Uploading clip ${index + 1} of ${uploadable.length} and queuing it for CCTV Review.`);
          const uploaded = await uploadPreparedVideo(prepared, true, (progress) => {
            setBatchProgress(index, 0.55 + ((progress ?? 0) / 100) * 0.4, uploadable.length);
          }, {
            batch_id: batchId,
            clip_index: index + 1,
            clip_total: uploadable.length,
            channel: recording.channel,
            start_time: recording.start_time,
            end_time: recording.end_time,
            fragment_count: recording.fragment_count,
            source_bytes: recording.bytes,
            cache_sha256: cacheResult.sha256,
          });
          if (!uploaded) throw new Error('Upload or registration did not complete. The cached file was preserved.');
          succeeded += 1;
          setAutoSucceeded(succeeded);
          setBatchProgress(index, 0.98, uploadable.length);
          if (stopIfPaused()) return;
        } catch (clipError) {
          failed += 1;
          setAutoFailed(failed);
          setError(clipError instanceof Error ? clipError.message : 'One recording did not complete.');
          if (stopIfPaused()) return;
        }
      }
      setAutoStage('registered');
      setAutoProgress(100);
      setAutoClipIndex(uploadable.length);
      setAutoMessage(`SD-card batch complete. ${succeeded} recording${succeeded === 1 ? '' : 's'} queued for CCTV Review${failed ? `; ${failed} failed and need retry` : ''}.`);
    } catch (cause) {
      setAutoStage('failed');
      setAutoMessage(cause instanceof Error ? cause.message : 'Processing did not complete.');
      setError(cause instanceof Error ? cause.message : 'Processing did not complete.');
    }
  };

  if (!signedInAs) {
    return <main className="desktop-companion login-shell">
      <header className="companion-header">
        <div className="companion-brand"><span className="companion-brand-mark" aria-hidden="true"><Camera size={24} /></span><div><span>Iron Eagle Security</span><h1>FCM Desktop</h1></div></div>
      </header>
      <section className="desktop-login-card" aria-labelledby="desktop-login-title">
        <div className="desktop-login-icon"><ShieldCheck size={28} /></div>
        <span className="workspace-heading-label">Secure evidence workstation</span>
        <h2 id="desktop-login-title">Sign in to FCM Desktop</h2>
        <p>Sign in with your authorised FCM account to access evidence intake, CCTV processing, and governed review. Your card data stays read-only locally; evidence and compliance decisions remain protected in FCM.</p>
        <form className="desktop-login-form" onSubmit={(event) => void signIn(event)}>
          <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@organisation.nz" required /></label>
          <label><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" required /></label>
          <button type="submit">Sign in securely</button>
        </form>
        {error && <div className="companion-error" role="alert">{error}</div>}
        <div className="desktop-login-boundary"><strong>Why sign-in is required</strong><span>Only authorised users can inspect recordings, upload evidence, or open governed compliance workflows.</span></div>
      </section>
    </main>;
  }

  return <main className="desktop-companion">
    <header className="companion-header">
      <div className="companion-brand"><span className="companion-brand-mark" aria-hidden="true"><Camera size={24} /></span><div><span>Iron Eagle Security</span><h1>FCM Desktop</h1></div></div>
      {signedInAs ? <div className="companion-session"><span><Wifi size={14} /> Connected as {signedInAs}</span><button type="button" className="icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={17} /></button></div> : <form className="sign-in-form" onSubmit={(event) => void signIn(event)}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" required /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" required /><button type="submit">Sign in</button></form>}
    </header>
    <div className="companion-layout">
      <nav className="companion-nav" aria-label="FCM Desktop navigation">
        <button type="button" className={activeView === 'home' ? 'is-active' : ''} onClick={() => setActiveView('home')}><MonitorPlay size={18} /> Desktop home</button>
        <button type="button" className={activeView === 'sd-import-clean' ? 'is-active' : ''} onClick={() => setActiveView('sd-import-clean')}><HardDrive size={18} /> Import recordings</button>
        <button type="button" className={activeView === 'cctv-review' ? 'is-active' : ''} onClick={() => setActiveView('cctv-review')}><MonitorPlay size={18} /> CCTV review</button>
        <button type="button" className={activeView === 'video-upload' ? 'is-active' : ''} onClick={() => setActiveView('video-upload')}><Upload size={18} /> Video upload</button>
        <button type="button" onClick={() => void openExternal(FCM_WEB_URL)}><ExternalLink size={18} /> FCM web portal</button>
      </nav>
      <section className="companion-workspace">
        {error && <div className="companion-error" role="alert">{error}</div>}
        {!signedInAs && <section className="connection-notice"><strong>Sign in to begin</strong><span>Use your authorised FCM account. Evidence intake is local; hybrid GPU/VPS inference, review, approvals, and results remain centrally governed.</span></section>}
        {activeView === 'sd-import-clean' && <><div className="workspace-heading"><span>SD evidence intake</span><h2>Import Dahua camera footage</h2><p>Plug in the SD card, sign in, and let FCM cache every uploadable recording locally before queuing it for governed CCTV Review. The SD card is never modified.</p></div><section className="tool auto-process-panel"><div className="auto-process-heading"><div><span>Unattended review batch</span><h3>Process all SD recordings</h3></div><strong>{autoProgress}%</strong></div><div className="auto-process-steps" aria-label="Processing stages"><span className={autoStage === 'analysing' ? 'is-current' : ''}>Analyse card</span><span className={autoStage === 'enumerating' ? 'is-current' : ''}>Find recordings</span><span className={autoStage === 'caching' ? 'is-current' : ''}>Save H.265 cache</span><span className={autoStage === 'uploading' || autoStage === 'registered' ? 'is-current' : ''}>Queue CCTV review</span></div><div><button type="button" onClick={() => void processSdCardReviewBatch()} disabled={AUTO_PROCESS_ACTIVE_STAGES.includes(autoStage)}><RefreshCw size={16} className={AUTO_PROCESS_ACTIVE_STAGES.includes(autoStage) ? 'is-spinning' : ''} /> {autoStage === 'idle' || autoStage === 'failed' || autoStage === 'paused' ? 'Analyse SD card and process all clips' : 'Processing SD-card batch...'}</button><button type="button" onClick={pauseAutoProcess} disabled={!AUTO_PROCESS_ACTIVE_STAGES.includes(autoStage)}>Pause after step</button><button type="button" onClick={restartAutoProcess}>Restart</button></div><div className="auto-process-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={autoProgress}><span style={{ width: `${autoProgress}%` }} /></div><div className="auto-process-timing"><span>Elapsed <strong>{formatDuration(autoElapsedSeconds)}</strong></span><span>ETA <strong>{autoRemainingSeconds === null ? 'Calculating' : formatDuration(autoRemainingSeconds)}</strong></span><span>Progress <strong>{autoProgress}%</strong></span><span>Clip <strong>{autoClipTotal ? `${autoClipIndex}/${autoClipTotal}` : 'Waiting'}</strong></span><span>Queued <strong>{autoSucceeded}</strong></span><span>Needs retry <strong>{autoFailed}</strong></span></div><p><strong>{autoStage.replace(/_/g, ' ')}</strong> · {autoMessage}</p><p className="mounted-note">This processes one recording at a time, preserves the local H.265 file, and queues the uploaded evidence for governed CCTV Review.</p>{cachedClip && <div className="cache-actions"><span>Local H.265 cache: {cachedClip.cache_path}</span><button type="button" onClick={() => void openCachedClip()}>Open file</button><button type="button" onClick={() => void revealCachedClip()}>Show in folder</button></div>}</section>{report && <section className="results"><h2>Dahua DHFS card detected</h2><div className="metrics"><Metric label="Indexed recordings" value={report.valid_timestamped_record_count} /><Metric label="Media partition" value={removableDisks.flatMap((disk) => disk.partitions).filter((partition) => !partition.drive_letter).map((partition) => Math.round(partition.size_bytes / 1024 / 1024 / 1024)).join(', ') || 'Unknown'} suffix=" GB" /><Metric label="Card access" value="Read-only" /></div><p className="mounted-note">Select a recording below, or use Video upload for exported footage.</p></section>}</>}
        {activeView === 'cctv-review' && <><div className="workspace-heading"><span>Governed review handoff</span><h2>Open CCTV Review</h2><p>CCTV Review runs in the secured FCM web portal so queue state, evidence links, and human decisions remain centrally governed.</p></div><section className="tool cctv-handoff"><button type="button" onClick={() => void openExternal(FCM_CCTV_REVIEW_URL)}><ExternalLink size={16} /> Open CCTV Review</button><button type="button" onClick={() => void copyExternalLink(FCM_CCTV_REVIEW_URL)}>Copy review link</button><p>{FCM_CCTV_REVIEW_URL}</p></section><section className="results"><h2>What opens there</h2><div className="metrics"><Metric label="Evidence queue" value="CCTV" /><Metric label="Review state" value="Live" /><Metric label="Authority" value="Human" /></div><p className="mounted-note">If Windows blocks external opening, copy the link and paste it into your signed-in browser.</p></section></>}
        {activeView === 'sd-import' && false && removableDisks.some((disk) => disk.partitions.some((partition) => !partition.drive_letter)) && <section className="tool"><button type="button" onClick={() => void inspectDhfsHeaders()} disabled={dhfsLoading || analysisLoading}><Database size={16} /> {dhfsLoading ? 'Decoding DHFS...' : 'Decode DHFS headers'}</button><p>Reads only DHFS-marked 4 KB metadata headers from the first 64 KB of the unmounted partition.</p></section>}
        {dhfsHeaders && <section className="results"><h2>DHFS header decode</h2><p>Disk {dhfsHeaders.disk_number}, partition {dhfsHeaders.partition_number} · {dhfsHeaders.headers.length} metadata headers decoded</p><table><thead><tr><th>Offset</th><th>ASCII preview</th><th>SHA-256</th></tr></thead><tbody>{dhfsHeaders.headers.map((header) => <tr key={header.absolute_offset_bytes}><td>{header.absolute_offset_bytes.toLocaleString()}</td><td className="hash">{header.ascii_preview}</td><td className="hash">{header.sha256}</td></tr>)}</tbody></table></section>}
        {dhfsDpt && <section className="results"><h2>DHFS DPT comparison</h2><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ dhfsHeaders, dhfsDpt, partitionTable }, null, 2)).then(() => setStatus('Copied diagnostic JSON to the clipboard.'))}>Copy diagnostic JSON</button><p>{dhfsDpt.headers_identical ? 'The redundant DPT headers are byte-identical.' : `${dhfsDpt.differing_byte_offsets.length} differing byte offsets were found.`}</p><p className="hash">DPT header offsets: {dhfsDpt.dpt_header_offsets.join(', ')}</p><table><thead><tr><th>Relative field offset</th><th>Little-endian value</th><th>Big-endian value</th></tr></thead><tbody>{dhfsDpt.non_zero_u32_fields.map((field) => <tr key={field.relative_offset_bytes}><td>{field.relative_offset_bytes}</td><td>{field.little_endian_u32}</td><td>{field.big_endian_u32}</td></tr>)}</tbody></table></section>}
        {partitionTable && <section className="results"><h2>DHFS partition table (as our parser sees it)</h2><p>{partitionTable.entries.length ? `${partitionTable.entries.length} entries parsed before: ${partitionTable.stopped_reason}` : `No entries parsed: ${partitionTable.stopped_reason}`}</p><p className="hash">DPT marker at {partitionTable.dpt_marker_absolute_offset.toLocaleString()}, table starts at {partitionTable.table_start_absolute_offset.toLocaleString()}</p>{partitionTable.entries.length > 0 && <table><thead><tr><th>#</th><th>Partition offset</th><th>Superblock offset</th><th>Block size</th><th>Fragment blocks</th><th>Descriptor offset (blocks)</th><th>Video offset (blocks)</th><th>Descriptor count</th></tr></thead><tbody>{partitionTable.entries.map((entry) => <tr key={entry.index}><td>{entry.index}</td><td>{entry.partition_offset.toLocaleString()}</td><td>{entry.superblock_offset.toLocaleString()}</td><td>{entry.block_size.toLocaleString()}</td><td>{entry.fragment_size_blocks.toLocaleString()}</td><td>{entry.descriptor_offset_blocks.toLocaleString()}</td><td>{entry.video_offset_blocks.toLocaleString()}</td><td>{entry.descriptor_count.toLocaleString()}</td></tr>)}</tbody></table>}</section>}
        {activeView === 'sd-import' && false && <section className="results"><h2>Dahua export handoff</h2><p>The card is DHFS 4.1. Use a DHFS-compatible viewer to export a selected recording as MP4/AVI, then upload it through FCM Desktop for VPS inference.</p><button type="button" onClick={() => void detectDahuaExportTools()} disabled={toolDetectionLoading}>{toolDetectionLoading ? 'Checking installed tools...' : 'Find installed Dahua export tools'}</button>{exportTools !== null && <>{exportTools?.length ? <ul className="export-tool-list">{exportTools?.map((tool) => <li key={tool.executable_path}><strong>{tool.name}</strong><span>{tool.executable_path}</span></li>)}</ul> : <p className="mounted-note">Install the official Dahua SmartPlayer/Toolbox or use a licensed DHFS forensic export tool. FCM does not replace their proprietary decoder.</p>}</>}</section>}
        {activeView === 'home' && <><div className="workspace-heading"><span>Hybrid field workstation</span><h2>FCM Desktop workspace</h2><p>Prepare evidence locally, send it to the governed hybrid inference pipeline, and open the operations portal for CCTV review, reporting, and approvals.</p></div><div className="capability-grid"><Capability icon={<HardDrive size={23} />} title="SD card import" detail="Inspect copied camera indexes and prepare evidence for review." action="Open importer" onClick={() => setActiveView('sd-import-clean')} /><Capability icon={<Camera size={23} />} title="Camera evidence" detail="Upload exported footage for GPU-first motion, person, ALPR, face, and vehicle analysis with VPS fallback." action="Upload video" onClick={() => setActiveView('video-upload')} /><Capability icon={<Database size={23} />} title="Operations portal" detail="Open FCM web for CCTV Review, Parking, Freedom Camping, and approvals." action="Open FCM web" onClick={() => void openExternal(FCM_WEB_URL)} /></div><section className="workflow-strip" aria-label="Hybrid evidence workflow"><WorkflowStep number="01" title="Prepare locally" detail="Read the card without changing it." /><WorkflowStep number="02" title="Process securely" detail="VPS and GPU services classify selected footage." /><WorkflowStep number="03" title="Review centrally" detail="Confirm findings in CCTV Review." /></section><section className="status-panel" aria-label="Workspace status"><div className="status-panel-heading"><div><span>Workspace status</span><h3>Connected services</h3></div><strong className={signedInAs ? 'status-good' : 'status-attention'}>{signedInAs ? 'Ready' : 'Sign-in required'}</strong></div><div className="status-grid"><StatusRow label="FCM cloud" detail={signedInAs ? `Signed in as ${signedInAs}` : 'Sign in to upload and register evidence'} tone={signedInAs ? 'good' : 'attention'} /><StatusRow label="Local workstation" detail={physicalRecordings.length ? `${physicalRecordings.length.toLocaleString()} card recordings indexed` : 'Read-only card access and secure clip cache available'} tone="good" /><StatusRow label="Inference lane" detail={uploadProgress !== null && uploadProgress < 100 ? 'Uploading selected evidence' : cachedClip ? 'Selected clip ready for secure upload' : 'GPU-first with VPS fallback'} tone="good" /></div></section><section className="read-only-notice"><strong>Local hardware, central governance</strong><span>The desktop never writes to an SD card. Evidence stays private, while inference results and formal decisions remain centrally governed.</span></section></>}
        {activeView === 'sd-import' && <><div className="workspace-heading"><span>Evidence intake</span><h2>SD card files and partitions</h2><p>Analyse the inserted card to find the camera index, hidden recording partition, and a bounded mapping sample automatically.</p></div><section className="tool"><button type="button" onClick={() => void analyseInsertedSdCard()} disabled={analysisLoading}><RefreshCw size={16} className={analysisLoading ? 'is-spinning' : ''} /> Analyse inserted SD card</button><button type="button" onClick={() => void scanDhfsMetadata()} disabled={dhfsLoading || analysisLoading}><Database size={16} /> {dhfsLoading ? 'Scanning DHFS...' : 'Scan DHFS metadata'}</button><button type="button" onClick={() => void detectRemovableDisks()} disabled={diskLoading || analysisLoading}><HardDrive size={16} /> Detect partitions</button><button type="button" onClick={() => void inspectMountedFolder()}><FileText size={16} /> Browse mounted files</button><button type="button" onClick={() => void inspectIndex()}><Database size={16} /> Choose SDFileInfo.db</button><p>{status}</p></section>{removableDisks.map((disk) => <section className="results" key={disk.disk_number}><h2>Disk {disk.disk_number}: {disk.friendly_name || 'Removable disk'}</h2><p>{formatBytes(disk.size_bytes)} · {disk.bus_type} · {disk.operational_status}</p><table><thead><tr><th>Partition</th><th>Size</th><th>Filesystem</th><th>Windows access</th><th>Read-only probe</th></tr></thead><tbody>{disk.partitions.map((partition) => <tr key={partition.partition_number}><td>{partition.partition_number}</td><td>{formatBytes(partition.size_bytes)}</td><td>{partition.filesystem || 'Unknown or proprietary'}</td><td>{partition.drive_letter ? `${partition.drive_letter}: mounted` : 'Not mounted'}</td><td>{!partition.drive_letter && <><button type="button" onClick={() => void probePartitionHeader(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null}>{probeLoading === `${disk.disk_number}:${partition.partition_number}` ? 'Probing...' : 'Probe header'}</button><button type="button" onClick={() => void probeFirstIndexedCluster(disk.disk_number, partition.partition_number)} disabled={probeLoading !== null || !report}>{probeLoading === `${disk.disk_number}:${partition.partition_number}:cluster` ? 'Sampling...' : 'Test first index'}</button></>}</td></tr>)}</tbody></table>{disk.partitions.some((partition) => !partition.drive_letter) && <p className="mounted-note"><AlertTriangle size={15} /> Analysis and probes are read-only. Do not format or repair an unmounted partition.</p>}</section>)}{dhfsScan && <section className="results"><h2>DHFS metadata reconnaissance</h2><p>Disk {dhfsScan.disk_number}, partition {dhfsScan.partition_number} · scanned {formatBytes(dhfsScan.bytes_scanned)}{dhfsScan.truncated ? ' (bounded first 16 MB)' : ''}</p><p className="mounted-note">DHFS markers found: {dhfsScan.dhfs_marker_offsets.length}. Non-zero 4 KB metadata blocks reported: {dhfsScan.non_zero_block_offsets.length}.</p><p className="hash">DHFS marker offsets: {dhfsScan.dhfs_marker_offsets.length ? dhfsScan.dhfs_marker_offsets.join(', ') : 'none beyond the header'}<br />Non-zero block offsets: {dhfsScan.non_zero_block_offsets.length ? dhfsScan.non_zero_block_offsets.join(', ') : 'none'}</p></section>}{partitionProbe && <section className="results"><h2>Partition header report</h2><p><strong>Disk {partitionProbe.disk_number}, partition {partitionProbe.partition_number}</strong> · offset {partitionProbe.offset_bytes.toLocaleString()} bytes · {partitionProbe.bytes_read.toLocaleString()} bytes read</p><p className="mounted-note">{partitionProbe.format_hint}</p><p className="hash">SHA-256: {partitionProbe.sha256}<br />First 32 bytes: {partitionProbe.signature}</p></section>}{clusterReport && <section className="results"><h2>Indexed cluster mapping report</h2><p>Disk {clusterReport.disk_number}, partition {clusterReport.partition_number} · index cluster {clusterReport.cluster_number}</p><table><thead><tr><th>Candidate block size</th><th>Absolute offset</th><th>Result</th></tr></thead><tbody>{clusterReport.samples.map((sample) => <tr key={sample.multiplier_bytes}><td>{sample.multiplier_bytes.toLocaleString()} bytes</td><td>{sample.absolute_offset_bytes.toLocaleString()} bytes</td><td>{sample.format_hint}</td></tr>)}</tbody></table><p className="hash">Each sample is 4 KB. No video is exported at this stage.</p></section>}{mountedFiles && <section className="results"><div className="metrics"><Metric label="Mounted files" value={mountedFiles.file_count} /><Metric label="Total data" value={Math.round(mountedFiles.total_bytes / 1024 / 1024)} /><Metric label="File limit" value={mountedFiles.truncated ? 5000 : mountedFiles.file_count} /></div><p className="hash">Source: {mountedFiles.folder_path}</p><table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>{mountedFiles.files.map((file) => <tr key={file.relative_path}><td><FileText size={14} /> {file.relative_path}</td><td>{formatBytes(file.size_bytes)}</td></tr>)}</tbody></table></section>}</>}
        {activeView === 'video-upload' && <><div className="workspace-heading"><span>Evidence intake</span><h2>Upload evidence or partition image</h2><p>Select any file, including a read-only Dahua DHFS partition image. Files upload directly to private Bob storage; video is additionally queued for CCTV inference.</p></div><section className="tool upload-tool"><input type="file" disabled={!signedInAs || uploadProgress !== null && uploadProgress < 100} onChange={(event) => { setVideo(event.target.files?.[0] ?? null); setUploadProgress(null); }} /><button type="button" onClick={() => void uploadVideo()} disabled={!signedInAs || !video || uploadProgress !== null && uploadProgress < 100}><Upload size={16} /> Upload to Bob storage</button>{video && <p>Selected: {video.name} ({formatBytes(video.size)})</p>}{uploadStatus && <p>{uploadStatus}</p>}{uploadProgress !== null && <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress}><span style={{ width: `${uploadProgress}%` }} /></div>}</section></>}
    {physicalRecordings.length > 0 && <section className="results"><h2>Recordings read directly from the card</h2><p className="mounted-note">No full-card image was created. The unattended batch caches and queues every uploadable recording; use the row action only for a single manual retry.</p><table><thead><tr><th>Channel</th><th>Start</th><th>End</th><th>Fragments</th><th>Size</th><th></th></tr></thead><tbody>{physicalRecordings.slice(0, 200).map((recording) => {
      const recordingKey = `${recording.dhfs_partition_index}-${recording.descriptor}`;
      return <tr key={recordingKey}><td>{recording.channel}</td><td>{recording.start_time}</td><td>{recording.end_time}</td><td>{recording.fragment_count}</td><td>{formatBytes(recording.bytes)}</td><td><button type="button" onClick={() => void extractCardRecordingToCache(recording)} disabled={cardExtractionLoading !== null}>{cardExtractionLoading === recordingKey ? 'Reading card...' : 'Extract to cache'}</button></td></tr>;
    })}</tbody></table><p className="hash">Showing up to 200 of {physicalRecordings.length.toLocaleString()} recordings.</p></section>}
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

function WorkflowStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="workflow-step"><strong>{number}</strong><div><b>{title}</b><span>{detail}</span></div></div>;
}

function StatusRow({ label, detail, tone }: { label: string; detail: string; tone: 'good' | 'attention' }) {
  return <div className="status-row"><span className={`status-dot status-dot-${tone}`} /><div><b>{label}</b><span>{detail}</span></div></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);