import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Activity, CheckCircle2, ChevronRight, Database, HardDrive, LockKeyhole, Search, ShieldCheck, Square, Upload, Waves } from 'lucide-react';
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
};

type AcquisitionReceipt = {
  sourceId: string;
  imagePath: string;
  bytesCopied: number;
  sourceSha256: string;
  imageSha256: string;
  verified: boolean;
  readErrors: number;
};

type InspectionResult = {
  imageBytes: number;
  signatures: string[];
  candidateOffsets: number[];
  adapters: Array<{ name: string; state: string; confidence: string; detail: string }>;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
  const [status, setStatus] = useState('Connect a camera card to begin a read-only acquisition.');
  const [error, setError] = useState<string | null>(null);

  const selectedSize = useMemo(() => selectedDevice ? formatBytes(selectedDevice.sizeBytes) : 'No source selected', [selectedDevice]);

  const discover = async () => {
    setStage('discovery'); setError(null); setStatus('Enumerating removable devices without opening a write handle...');
    try {
      const found = await invoke<DeviceCandidate[]>('discover_read_only_devices');
      setDevices(found); setSelectedDevice(found[0] || null); setStage(found.length ? 'ready' : 'idle');
      setStatus(found.length ? `${found.length} removable source${found.length === 1 ? '' : 's'} available for acquisition.` : 'No removable source found.');
    } catch (cause) { setStage('failed'); setError(cause instanceof Error ? cause.message : 'Device discovery failed.'); }
  };

  const acquire = async () => {
    if (!selectedDevice) return;
    const destination = await save({ title: 'Save immutable source image', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-acquisitions\\source.img', filters: [{ name: 'Disk image', extensions: ['img'] }] });
    if (!destination) return;
    setStage('cloning'); setError(null); setReceipt(null); setInspection(null); setDecoderStage('not_started'); setStatus('Reading the source with a read-only handle. The card will not be modified.');
    try {
      const result = await invoke<AcquisitionReceipt>('acquire_read_only_device_image', { sourceId: selectedDevice.id, destinationPath: destination });
      setReceipt(result); setStage('complete'); setStatus(result.verified ? 'Acquisition verified. The prototype now works from the immutable image.' : 'Image created but verification requires attention.');
    } catch (cause) { setStage('failed'); setError(cause instanceof Error ? cause.message : 'Acquisition failed.'); }
  };

  const inspectImage = async () => {
    if (!receipt) return;
    setDecoderStage('scanning'); setError(null); setStatus('Scanning the image for partition signatures, candidate offsets, and decoder adapters...');
    try {
      const result = await invoke<InspectionResult>('inspect_acquisition_image', { imagePath: receipt.imagePath });
      setInspection(result); setDecoderStage(result.adapters.some((adapter) => adapter.state === 'ambiguous') ? 'ambiguous' : 'identified'); setStatus('Image inspection complete. No source bytes were changed.');
    } catch (cause) { setDecoderStage('failed'); setError(cause instanceof Error ? cause.message : 'Image inspection failed.'); }
  };

  return <main className="v2-shell">
    <aside className="rail"><div className="brand"><span><Waves size={19} /></span><div><b>FCM</b><small>Desktop V2</small></div></div><nav><button className="is-active"><HardDrive size={17} /> Acquisition</button><button><Database size={17} /> Image explorer</button><button><Search size={17} /> Decoder lab</button></nav><div className="rail-note"><LockKeyhole size={16} /><span>Prototype only. V1 remains the working field bridge.</span></div></aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">Evidence workstation / prototype</span><h1>Clone first. Decode second.</h1><p>Preserve the exact camera source locally, then inspect the virtual image with multiple decoder adapters.</p></div><div className="topbar-badge"><ShieldCheck size={17} /> Read-only source</div></header>
      <section className="steps"><Step number="01" title="Discover" detail="Find removable media" complete={stage !== 'idle' && stage !== 'discovery'} active={stage === 'discovery'} /><ChevronRight size={17} /><Step number="02" title="Acquire" detail="Clone and verify" complete={stage === 'complete'} active={stage === 'cloning' || stage === 'verifying'} /><ChevronRight size={17} /><Step number="03" title="Inspect" detail="Map and decode" complete={Boolean(inspection)} active={decoderStage === 'scanning'} /></section>
      <div className="grid">
        <section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">01 / Source</span><h2>Read-only device discovery</h2></div><Activity size={19} /></div><p className="muted">FCM opens the source read-only and never mounts or writes the camera card.</p><button className="primary" onClick={() => void discover()} disabled={stage === 'discovery'}><HardDrive size={16} /> {stage === 'discovery' ? 'Scanning...' : 'Discover removable media'}</button>{devices.length > 0 && <div className="device-list">{devices.map((device) => <button key={device.id} className={`device ${selectedDevice?.id === device.id ? 'is-selected' : ''}`} onClick={() => setSelectedDevice(device)}><span className="device-icon"><HardDrive size={17} /></span><span><strong>{device.label}</strong><small>{formatBytes(device.sizeBytes)} · {device.partitions} partitions · {device.readOnly ? 'read-only' : 'write protection unknown'}</small></span><CheckCircle2 size={16} /></button>)}</div>}{selectedDevice && <div className="source-facts"><span>Selected source<strong>{selectedDevice.label}</strong></span><span>Capacity<strong>{selectedSize}</strong></span><span>Write mode<strong>Blocked</strong></span></div>}</section>
        <section className="panel acquire-panel"><div className="panel-heading"><div><span className="eyebrow">02 / Acquisition</span><h2>Immutable source image</h2></div><LockKeyhole size={19} /></div><p className="muted">The image becomes the working copy. The card remains untouched and can be safely removed after verification.</p><button className="primary" onClick={() => void acquire()} disabled={!selectedDevice || stage === 'cloning'}><Square size={15} /> Acquire exact image</button><div className={`status-card status-${stage}`}><span>{stageLabel[stage]}</span><strong>{receipt ? `${formatBytes(receipt.bytesCopied)} copied` : 'No acquisition receipt yet'}</strong><small>{status}</small></div>{receipt && <div className="receipt"><div><CheckCircle2 size={17} /><strong>Hash verification {receipt.verified ? 'passed' : 'needs review'}</strong></div><dl><div><dt>Source SHA-256</dt><dd>{receipt.sourceSha256}</dd></div><div><dt>Image SHA-256</dt><dd>{receipt.imageSha256}</dd></div><div><dt>Read errors</dt><dd>{receipt.readErrors}</dd></div></dl></div>}</section>
        <section className="panel inspect-panel"><div className="panel-heading"><div><span className="eyebrow">03 / Decoder lab</span><h2>Virtual image inspection</h2></div><Search size={19} /></div><p className="muted">Run several adapters against the clone. Unknown layouts are preserved as investigation candidates instead of rejected.</p><button className="secondary" onClick={() => void inspectImage()} disabled={!receipt || decoderStage === 'scanning'}><Search size={16} /> {decoderStage === 'scanning' ? 'Inspecting...' : 'Inspect image and map partitions'}</button>{inspection && <div className="inspection"><div className="facts"><span>Image<strong>{formatBytes(inspection.imageBytes)}</strong></span><span>Signatures<strong>{inspection.signatures.length}</strong></span><span>Offsets<strong>{inspection.candidateOffsets.length}</strong></span></div><div className="signature-list">{inspection.signatures.map((signature) => <span key={signature}>{signature}</span>)}</div>{inspection.adapters.map((adapter) => <div className="adapter" key={adapter.name}><span className={`dot dot-${adapter.state}`} /><div><strong>{adapter.name}</strong><small>{adapter.detail}</small></div><em>{adapter.confidence}</em></div>)}</div>}</section>
      </div>
      {error && <div className="error"><strong>Action blocked</strong><span>{error}</span></div>}
      <footer><span><ShieldCheck size={14} /> V2 prototype keeps acquisition, inspection, and decoder evidence separate.</span><span>{stageLabel[stage]} · decoder {decoderStage.replace('_', ' ')}</span></footer>
    </section>
  </main>;
}
