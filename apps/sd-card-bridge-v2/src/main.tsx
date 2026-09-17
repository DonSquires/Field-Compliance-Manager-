import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Activity, CheckCircle2, ChevronRight, Clapperboard, Database, Download, FolderOpen, HardDrive, LockKeyhole, Search, ShieldCheck, Square, Waves } from 'lucide-react';
import './styles.css';

type AcquisitionStage = 'idle' | 'discovery' | 'ready' | 'cloning' | 'verifying' | 'complete' | 'failed';
type DecoderStage = 'not_started' | 'scanning' | 'identified' | 'ambiguous' | 'failed';

type DeviceCandidate = {
  id: string;
  label: string;
  sizeBytes: number;
  removable: boolean;
  readOnly: boolean;
  partitions: number;
  partitionStyle: string;
  busType: string;
  driveLetters: string[];
  offline: boolean;
};

type DeviceProbe = {
  id: string;
  sizeBytes: number;
  sector0Hex: string;
  sector0Ascii: string;
  mbrSignature: boolean;
  mbrPartitions: string[];
  dhfsMagicAtZero: boolean;
  dhfsDptMarkerWithinFirstMib: number | null;
  dhfsLocation: string | null;
  dhfsError: string | null;
};

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

type AcquisitionReceipt = {
  sourceId: string;
  imagePath: string;
  bytesCopied: number;
  sourceSha256: string;
  imageSha256: string;
  verified: boolean;
  readErrors: number;
};

type AcquisitionProgress = {
  sourceId: string;
  stage: 'cloning' | 'verifying' | 'complete' | 'mismatch';
  bytesDone: number;
  totalBytes: number;
  elapsedSeconds: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
};

type DhfsTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

type DhfsPartition = {
  index: number;
  partitionOffset: number;
  superblockOffset: number;
  blockSize: number;
  fragmentBlocks: number;
  descriptorCount: number;
  firstDate: DhfsTime | null;
  lastDate: DhfsTime | null;
  fragmentSize: number;
  capacityBytes: number;
};

type DhfsVolume = {
  location: { baseOffset: number; method: 'device_start' | 'mbr_partition' | 'gpt_partition' | 'scan'; index?: number; typeCode?: number };
  dptMarkerOffset: number;
  partitions: DhfsPartition[];
  tableNote: string;
};

type DhfsRecording = {
  partitionIndex: number;
  descriptor: number;
  channel: number;
  start: DhfsTime;
  end: DhfsTime;
  durationSeconds: number;
  fragmentCount: number;
  bytes: number;
};

type DhfsCatalog = { volume: DhfsVolume; recordings: DhfsRecording[]; skippedDescriptors: number; warnings: string[] };

type ExtractedClip = {
  path: string;
  fileName: string;
  bytes: number;
  sha256: string;
  contentType: string;
  codec: string;
  streamStartOffset: number;
  channel: number;
  durationSeconds: number;
  fragments: number;
  descriptor: number;
  partitionIndex: number;
};

type InspectionResult = {
  imageBytes: number;
  signatures: string[];
  candidateOffsets: number[];
  adapters: Array<{ name: string; state: string; confidence: string; detail: string }>;
  dhfs: DhfsVolume | null;
  dhfsError: string | null;
};

/** Which bytes the DHFS reader walks: the verified image (evidence path) or the card itself (read-only, no clone). */
type DhfsSource = { kind: 'image'; path: string } | { kind: 'device'; id: string; sizeBytes: number };

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

const pad = (value: number) => String(value).padStart(2, '0');
const formatTime = (time: DhfsTime | null | undefined) => (time ? `${time.year}-${pad(time.month)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}` : '—');
const formatClock = (time: DhfsTime) => `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
const formatDay = (time: DhfsTime) => `${time.year}-${pad(time.month)}-${pad(time.day)}`;
const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
};
const formatRate = (bytesPerSecond: number) => (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s` : '—');
/** Rough clone time for a card of `bytes` at a conservative USB reader rate, so the operator can decide before committing. */
const estimateCloneMinutes = (bytes: number) => Math.max(1, Math.round(bytes / (40 * 1024 ** 2) / 60));
const recordingKey = (recording: DhfsRecording) => `${recording.partitionIndex}:${recording.descriptor}`;
const locationLabel = (volume: DhfsVolume) => {
  switch (volume.location.method) {
    case 'device_start': return 'raw device, no partition table';
    case 'mbr_partition': return `MBR partition ${(volume.location.index ?? 0) + 1} (RAW to Windows)`;
    case 'gpt_partition': return `GPT partition ${(volume.location.index ?? 0) + 1}`;
    default: return 'found by sector scan';
  }
};

const stageLabel: Record<AcquisitionStage, string> = {
  idle: 'Waiting for source', discovery: 'Inspecting devices', ready: 'Ready to acquire', cloning: 'Acquiring read-only image', verifying: 'Verifying hashes', complete: 'Acquisition verified', failed: 'Acquisition failed',
};

function Step({ number, title, detail, active, complete }: { number: string; title: string; detail: string; active?: boolean; complete?: boolean }) {
  return <div className={`step ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}><span>{complete ? <CheckCircle2 size={16} /> : number}</span><div><strong>{title}</strong><small>{detail}</small></div></div>;
}

export default function App() {
  const [stage, setStage] = useState<AcquisitionStage>('idle');
  const [decoderStage, setDecoderStage] = useState<DecoderStage>('not_started');
  const [devices, setDevices] = useState<DeviceCandidate[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCandidate | null>(null);
  const [receipt, setReceipt] = useState<AcquisitionReceipt | null>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [catalog, setCatalog] = useState<DhfsCatalog | null>(null);
  const [catalogSource, setCatalogSource] = useState<DhfsSource | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState<string | null>(null);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [clips, setClips] = useState<Record<string, ExtractedClip>>({});
  const [status, setStatus] = useState('Connect a camera card to begin a read-only acquisition.');
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<DeviceProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [progress, setProgress] = useState<AcquisitionProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const describeFailure = (cause: unknown, fallback: string) => (typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : fallback);
  const failWith = (cause: unknown, fallback: string) => setError(describeFailure(cause, fallback));

  useEffect(() => {
    // A rejected promise outside a handler used to vanish: the operator saw a button that "did nothing".
    const onRejection = (event: PromiseRejectionEvent) => { event.preventDefault(); setError(`Unhandled failure: ${describeFailure(event.reason, String(event.reason))}`); };
    const onError = (event: ErrorEvent) => setError(`Interface error: ${event.message}`);
    window.addEventListener('unhandledrejection', onRejection); window.addEventListener('error', onError);
    return () => { window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('error', onError); };
  }, []);

  const selectedSize = useMemo(() => selectedDevice ? formatBytes(selectedDevice.sizeBytes) : 'No source selected', [selectedDevice]);
  const recordingDays = useMemo(() => {
    const groups = new Map<string, DhfsRecording[]>();
    for (const recording of catalog?.recordings ?? []) {
      const day = formatDay(recording.start);
      groups.set(day, [...(groups.get(day) ?? []), recording]);
    }
    return [...groups.entries()];
  }, [catalog]);
  const totalRecordingBytes = useMemo(() => (catalog?.recordings ?? []).reduce((sum, recording) => sum + recording.bytes, 0), [catalog]);
  const sourceLabel = (source: DhfsSource | null) => (source ? (source.kind === 'image' ? 'verified image' : `card ${source.id}`) : 'no source');

  const discover = async () => {
    setStage('discovery'); setError(null); setProbe(null); setStatus('Enumerating disks without opening a write handle...');
    try {
      const found = await invoke<DeviceCandidate[]>('discover_read_only_devices');
      setDevices(found); setSelectedDevice(found[0] || null); setStage(found.length ? 'ready' : 'idle');
      setStatus(found.length
        ? `${found.length} disk${found.length === 1 ? '' : 's'} available besides the Windows system disk. Pick the card (its drive letter is shown), then list recordings directly from it.`
        : 'No disk besides the Windows system disk was found. Reseat the card, wait for Windows to notice it (cancel any "format the disk" prompt), then discover again.');
    } catch (cause) { setStage('failed'); failWith(cause, 'Device discovery failed.'); }
  };

  const probeDevice = async (device: DeviceCandidate) => {
    setProbing(true); setProbe(null);
    try {
      setProbe(await invoke<DeviceProbe>('probe_device', { id: device.id, sizeBytes: device.sizeBytes }));
    } catch (cause) {
      setProbe({ id: device.id, sizeBytes: device.sizeBytes, sector0Hex: '', sector0Ascii: '', mbrSignature: false, mbrPartitions: [], dhfsMagicAtZero: false, dhfsDptMarkerWithinFirstMib: null, dhfsLocation: null, dhfsError: typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'The card could not be probed.' });
    } finally { setProbing(false); }
  };

  const acquire = async () => {
    if (!selectedDevice) return;
    setError(null);
    let destination: string | null;
    try {
      destination = await save({ title: 'Save immutable source image', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-acquisitions\\source.img', filters: [{ name: 'Disk image', extensions: ['img'] }] });
    } catch (cause) { failWith(cause, 'The save dialog could not be opened.'); return; }
    if (!destination) { setStatus('Acquisition not started: no destination was chosen.'); return; }
    setStage('cloning'); setReceipt(null); setInspection(null); setDecoderStage('not_started'); setProgress(null); setCancelling(false);
    setStatus(`Cloning ${formatBytes(selectedDevice.sizeBytes)} with a read-only handle (roughly ${estimateCloneMinutes(selectedDevice.sizeBytes)} min over USB). The card will not be modified.`);
    const unlisten = await listen<AcquisitionProgress>('acquisition-progress', (event) => {
      if (event.payload.sourceId !== selectedDevice.id) return;
      setProgress(event.payload);
      if (event.payload.stage === 'verifying') setStage('verifying');
    });
    try {
      const result = await invoke<AcquisitionReceipt>('acquire_read_only_device_image', { sourceId: selectedDevice.id, destinationPath: destination, sizeBytes: selectedDevice.sizeBytes });
      setReceipt(result); setStage('complete'); setStatus(result.verified ? 'Acquisition verified: source and image hashes match. The prototype now works from the immutable image.' : 'Image created but the verification hashes do not match. Treat the image as suspect.');
    } catch (cause) { setStage('failed'); failWith(cause, 'Acquisition failed.'); }
    finally { unlisten(); setCancelling(false); }
  };

  const cancelAcquisition = async () => {
    setCancelling(true);
    try { await invoke('cancel_acquisition'); } catch (cause) { failWith(cause, 'Cancel request failed.'); }
  };

  const readCatalog = async (source: DhfsSource) => {
    setCatalogBusy(true); setError(null); setCatalog(null); setCatalogSource(source); setClips({}); setProbe(null);
    setStatus(source.kind === 'image' ? 'Walking the DHFS partition table and fragment descriptors inside the image...' : 'Reading the DHFS partition table directly from the card (read-only, sector-aligned)...');
    try {
      const result = await invoke<DhfsCatalog>('read_dhfs_catalog', { source });
      setCatalog(result);
      const partition = result.volume.partitions[0];
      setStatus(`${result.recordings.length} recording${result.recordings.length === 1 ? '' : 's'} on the hidden DHFS partition (${locationLabel(result.volume)}), ${formatTime(partition?.firstDate)} to ${formatTime(partition?.lastDate)}.${result.skippedDescriptors ? ` ${result.skippedDescriptors} descriptor${result.skippedDescriptors === 1 ? '' : 's'} skipped as untrustworthy.` : ''}`);
    } catch (cause) {
      failWith(cause, 'The DHFS catalog could not be read.');
      // Show what the first sectors actually hold so the failure is describable, not a shrug.
      if (source.kind === 'device') { const device = devices.find((candidate) => candidate.id === source.id); if (device) await probeDevice(device); }
    }
    finally { setCatalogBusy(false); }
  };

  const inspectImage = async () => {
    if (!receipt) return;
    setDecoderStage('scanning'); setError(null); setStatus('Scanning the image for partition signatures, then walking the DHFS volume...');
    try {
      const result = await invoke<InspectionResult>('inspect_acquisition_image', { imagePath: receipt.imagePath });
      setInspection(result); setDecoderStage(result.dhfs ? 'identified' : result.adapters.some((adapter) => adapter.state === 'ambiguous') ? 'ambiguous' : 'identified'); setStatus('Image inspection complete. No source bytes were changed.');
      if (result.dhfs) await readCatalog({ kind: 'image', path: receipt.imagePath });
    } catch (cause) { setDecoderStage('failed'); failWith(cause, 'Image inspection failed.'); }
  };

  const chooseDestination = async () => {
    try {
      const chosen = await open({ title: 'Choose where extracted clips are written', directory: true, multiple: false, defaultPath: 'C:\\Users\\Public\\Documents\\fcm-acquisitions' });
      if (typeof chosen === 'string') setDestinationDirectory(chosen);
      return typeof chosen === 'string' ? chosen : null;
    } catch (cause) { failWith(cause, 'The folder dialog could not be opened.'); return null; }
  };

  const extract = async (recording: DhfsRecording) => {
    if (!catalogSource) return;
    const directory = destinationDirectory ?? await chooseDestination();
    if (!directory) return;
    const key = recordingKey(recording);
    setExtracting(key); setError(null); setStatus(`Extracting channel ${recording.channel}, ${formatTime(recording.start)} (${formatBytes(recording.bytes)}) from the ${sourceLabel(catalogSource)}...`);
    try {
      const clip = await invoke<ExtractedClip>('extract_dhfs_recording', { source: catalogSource, partitionIndex: recording.partitionIndex, descriptor: recording.descriptor, destinationDirectory: directory });
      setClips((current) => ({ ...current, [key]: clip }));
      setStatus(`Wrote ${clip.fileName} (${formatBytes(clip.bytes)}, ${clip.codec}). SHA-256 recorded; the source was not modified.`);
    } catch (cause) { failWith(cause, 'Extraction failed.'); }
    finally { setExtracting(null); }
  };

  const catalogPartition = catalog?.volume.partitions[0];

  return <main className="v2-shell">
    <aside className="rail"><div className="brand"><span><Waves size={19} /></span><div><b>FCM</b><small>Desktop V2 · v{APP_VERSION}</small></div></div><nav><button className="is-active"><HardDrive size={17} /> Acquisition</button><button><Database size={17} /> Image explorer</button><button><Search size={17} /> Decoder lab</button></nav><div className="rail-note"><LockKeyhole size={16} /><span>Prototype only. V1 remains the working field bridge.</span></div></aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">Evidence workstation / prototype</span><h1>Clone first. Decode second.</h1><p>Preserve the exact camera source locally, then inspect the virtual image with multiple decoder adapters.</p></div><div className="topbar-badge"><ShieldCheck size={17} /> Read-only source</div></header>
      <section className="steps"><Step number="01" title="Discover" detail="Find removable media" complete={stage !== 'idle' && stage !== 'discovery'} active={stage === 'discovery'} /><ChevronRight size={17} /><Step number="02" title="Acquire" detail="Clone and verify" complete={stage === 'complete'} active={stage === 'cloning' || stage === 'verifying'} /><ChevronRight size={17} /><Step number="03" title="Inspect" detail="Map and decode" complete={Boolean(inspection)} active={decoderStage === 'scanning'} /><ChevronRight size={17} /><Step number="04" title="Recordings" detail="List and extract" complete={Boolean(catalog)} active={catalogBusy || Boolean(extracting)} /></section>
      <div className="grid">
        <section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">01 / Source</span><h2>Read-only device discovery</h2></div><Activity size={19} /></div><p className="muted">FCM opens the source read-only and never mounts or writes the camera card. A Dahua card usually shows in Explorer as a RAW drive letter that Windows offers to format — cancel that prompt; the letter is the hidden DHFS partition, not a fault. Reading a whole disk needs FCM Desktop V2 to be run as administrator.</p><button className="primary" onClick={() => void discover()} disabled={stage === 'discovery'}><HardDrive size={16} /> {stage === 'discovery' ? 'Scanning...' : 'Discover camera cards and disks'}</button>{devices.length > 0 && <div className="device-list">{devices.map((device) => <button key={device.id} className={`device ${selectedDevice?.id === device.id ? 'is-selected' : ''}`} onClick={() => { setSelectedDevice(device); setProbe(null); }}><span className="device-icon"><HardDrive size={17} /></span><span><strong>{device.driveLetters.length ? `${device.driveLetters.join(' ')} · ` : ''}{device.label}</strong><small>{device.id} · {formatBytes(device.sizeBytes)} · {device.busType}{device.removable ? ' (removable)' : ''} · {device.partitionStyle} · {device.partitions} partition{device.partitions === 1 ? '' : 's'}{device.offline ? ' · offline' : ''} · {device.readOnly ? 'read-only' : 'write protection unknown'}</small></span><CheckCircle2 size={16} /></button>)}</div>}{selectedDevice && <div className="source-facts"><span>Selected source<strong>{selectedDevice.driveLetters.length ? `${selectedDevice.driveLetters.join(' ')} · ` : ''}{selectedDevice.label}</strong></span><span>Capacity<strong>{selectedSize}</strong></span><span>Write mode<strong>Blocked</strong></span></div>}{selectedDevice && <div className="actions"><button className="secondary" onClick={() => void readCatalog({ kind: 'device', id: selectedDevice.id, sizeBytes: selectedDevice.sizeBytes })} disabled={catalogBusy || stage === 'cloning'}><Clapperboard size={16} /> {catalogBusy && catalogSource?.kind === 'device' ? 'Reading card...' : 'List recordings directly from card'}</button><button className="secondary" onClick={() => void probeDevice(selectedDevice)} disabled={probing || catalogBusy}><Search size={16} /> {probing ? 'Probing...' : 'Probe first sectors'}</button><small className="muted">Read-only, no clone. Use this to confirm what the card holds before committing to a full acquisition.</small></div>}{probe && <div className="probe"><strong>Card probe · {probe.id} · {formatBytes(probe.sizeBytes)}</strong><dl><div><dt>DHFS volume</dt><dd>{probe.dhfsLocation ?? probe.dhfsError ?? '—'}</dd></div><div><dt>DHFS4.1 at sector 0</dt><dd>{probe.dhfsMagicAtZero ? 'yes' : 'no'}</dd></div><div><dt>DHFS_DPT marker</dt><dd>{probe.dhfsDptMarkerWithinFirstMib === null ? 'not in first MiB' : `byte ${probe.dhfsDptMarkerWithinFirstMib.toLocaleString()}`}</dd></div><div><dt>MBR</dt><dd>{probe.mbrSignature ? (probe.mbrPartitions.length ? probe.mbrPartitions.join('; ') : 'signature present, no partition entries') : 'no MBR signature (superfloppy / raw)'}</dd></div><div><dt>Sector 0 (first 64 bytes)</dt><dd className="mono">{probe.sector0Hex || '—'}<br />{probe.sector0Ascii}</dd></div></dl><small className="muted">Copy this block into a support message if the card is not recognised.</small></div>}</section>
        <section className="panel acquire-panel"><div className="panel-heading"><div><span className="eyebrow">02 / Acquisition</span><h2>Immutable source image</h2></div><LockKeyhole size={19} /></div><p className="muted">The image becomes the working copy. The card remains untouched and can be safely removed after verification.{selectedDevice ? ` A ${formatBytes(selectedDevice.sizeBytes)} card takes roughly ${estimateCloneMinutes(selectedDevice.sizeBytes)} minutes over USB, then as long again to verify; listing recordings directly from the card is immediate.` : ''}</p><div className="actions"><button className="primary" onClick={() => void acquire()} disabled={!selectedDevice || stage === 'cloning' || stage === 'verifying'}><Square size={15} /> {stage === 'cloning' ? 'Cloning...' : stage === 'verifying' ? 'Verifying...' : 'Acquire exact image'}</button>{(stage === 'cloning' || stage === 'verifying') && <button className="secondary" onClick={() => void cancelAcquisition()} disabled={cancelling || stage === 'verifying'}>{cancelling ? 'Cancelling...' : 'Cancel'}</button>}</div><div className={`status-card status-${stage}`}><span>{stageLabel[stage]}</span><strong>{receipt ? `${formatBytes(receipt.bytesCopied)} copied` : progress ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.totalBytes)} · ${progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}%` : 'No acquisition receipt yet'}</strong>{progress && (stage === 'cloning' || stage === 'verifying') && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}><div style={{ width: `${progress.totalBytes ? Math.min(100, (progress.bytesDone / progress.totalBytes) * 100) : 0}%` }} /></div>}{progress && (stage === 'cloning' || stage === 'verifying') && <small className="mono">{progress.stage} · {formatRate(progress.bytesPerSecond)} · elapsed {formatDuration(progress.elapsedSeconds)} · remaining {progress.etaSeconds === null ? '—' : formatDuration(progress.etaSeconds)}</small>}<small>{status}</small></div>{receipt && <div className="receipt"><div><CheckCircle2 size={17} /><strong>Hash verification {receipt.verified ? 'passed' : 'needs review'}</strong></div><dl><div><dt>Source SHA-256</dt><dd>{receipt.sourceSha256}</dd></div><div><dt>Image SHA-256</dt><dd>{receipt.imageSha256}</dd></div><div><dt>Read errors</dt><dd>{receipt.readErrors}</dd></div></dl></div>}</section>
        <section className="panel inspect-panel"><div className="panel-heading"><div><span className="eyebrow">03 / Decoder lab</span><h2>Virtual image inspection</h2></div><Search size={19} /></div><p className="muted">Run several adapters against the clone. Unknown layouts are preserved as investigation candidates instead of rejected.</p><button className="secondary" onClick={() => void inspectImage()} disabled={!receipt || decoderStage === 'scanning'}><Search size={16} /> {decoderStage === 'scanning' ? 'Inspecting...' : 'Inspect image and map partitions'}</button>{inspection && <div className="inspection"><div className="facts"><span>Image<strong>{formatBytes(inspection.imageBytes)}</strong></span><span>Signatures<strong>{inspection.signatures.length}</strong></span><span>DHFS<strong>{inspection.dhfs ? locationLabel(inspection.dhfs) : 'not found'}</strong></span></div><div className="signature-list">{inspection.signatures.map((signature) => <span key={signature}>{signature}</span>)}</div>{inspection.adapters.map((adapter) => <div className="adapter" key={adapter.name}><span className={`dot dot-${adapter.state}`} /><div><strong>{adapter.name}</strong><small>{adapter.detail}</small></div><em>{adapter.confidence}</em></div>)}</div>}</section>
        <section className="panel recordings-panel"><div className="panel-heading"><div><span className="eyebrow">04 / Recordings</span><h2>Hidden DHFS partition</h2></div><Clapperboard size={19} /></div>
          {!catalog && <p className="muted">{catalogBusy ? 'Reading the partition table, superblock and fragment descriptors...' : 'Recordings appear here after the image is inspected, or straight from the card via the source panel.'}</p>}
          {catalog && catalogPartition && <>
            <div className="facts"><span>Source<strong>{sourceLabel(catalogSource)}</strong></span><span>Recordings<strong>{catalog.recordings.length} · {formatBytes(totalRecordingBytes)}</strong></span><span>Layout<strong>{formatBytes(catalogPartition.fragmentSize)} fragments · {catalogPartition.descriptorCount.toLocaleString()} descriptors</strong></span></div>
            <p className="muted small">Volume at byte {catalog.volume.location.baseOffset.toLocaleString()} ({locationLabel(catalog.volume)}). {catalog.volume.tableNote}{catalog.skippedDescriptors ? ` ${catalog.skippedDescriptors} untrustworthy descriptor${catalog.skippedDescriptors === 1 ? '' : 's'} skipped, not silently included.` : ''}</p>
            <div className="actions"><button className="secondary" onClick={() => void chooseDestination()}><FolderOpen size={15} /> {destinationDirectory ? 'Change clip folder' : 'Choose clip folder'}</button>{destinationDirectory && <small className="muted mono">{destinationDirectory}</small>}</div>
            {catalog.recordings.length === 0 && <p className="muted">The volume is intact but holds no trustworthy recordings.</p>}
            <div className="recording-days">{recordingDays.map(([day, recordings]) => <div className="recording-day" key={day}><div className="recording-day__head"><strong>{day}</strong><small>{recordings.length} recording{recordings.length === 1 ? '' : 's'} · {formatBytes(recordings.reduce((sum, recording) => sum + recording.bytes, 0))}</small></div>
              {recordings.map((recording) => { const key = recordingKey(recording); const clip = clips[key]; return <div className={`recording ${clip ? 'is-extracted' : ''}`} key={key}><span className="recording__time">{formatClock(recording.start)}</span><span className="recording__meta"><strong>Channel {recording.channel} · {formatDuration(recording.durationSeconds)}</strong><small>to {formatClock(recording.end)} · {formatBytes(recording.bytes)} · {recording.fragmentCount} fragment{recording.fragmentCount === 1 ? '' : 's'} · descriptor {recording.descriptor}</small>{clip && <small className="mono">{clip.fileName} · {clip.codec} · SHA-256 {clip.sha256.slice(0, 16)}…</small>}</span><button className={clip ? 'secondary' : 'primary'} onClick={() => void extract(recording)} disabled={Boolean(extracting)}><Download size={14} /> {extracting === key ? 'Extracting...' : clip ? 'Extract again' : 'Extract'}</button></div>; })}
            </div>)}</div>
            {catalog.warnings.length > 0 && <details className="warnings"><summary>{catalog.warnings.length} descriptor warning{catalog.warnings.length === 1 ? '' : 's'}</summary><ul>{catalog.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
          </>}
        </section>
      </div>
      {error && <div className="error"><strong>Action blocked</strong><span>{error}</span></div>}
      <footer><span><ShieldCheck size={14} /> V2 prototype keeps acquisition, inspection, and decoder evidence separate.</span><span>v{APP_VERSION} · {stageLabel[stage]} · decoder {decoderStage.replace('_', ' ')}{catalog ? ` · ${catalog.recordings.length} recordings` : ''}</span></footer>
    </section>
  </main>;
}

// The earlier prototype exported App without ever mounting it, so the installed window rendered blank.
const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
