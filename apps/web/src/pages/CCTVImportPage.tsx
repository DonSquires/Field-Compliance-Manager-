import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload as TusUpload } from 'tus-js-client';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileVideo2,
  FolderOpen,
  Images,
  MapPin,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  COMMON_TIME_ZONES,
  DEFAULT_SOURCE_TIME_ZONE,
  buildDeviceEvents,
  buildManifest,
  classifyFolder,
  detectDeviceKind,
  formatBytes,
  isValidTimeZone,
  storagePathFor,
  summarize,
  type DeviceKind,
  type ScanInput,
  type ScannedFile,
} from '../lib/cctvImportScan';
import './PageStyles.css';
import './CCTVImportPage.css';

interface HouseRow { id: string; name: string; address: string | null; organization_id: string }
interface SiteRow { id: string; name: string; address: string | null; location_id: string }
interface ZoneRow { id: string; name: string; module_key: string | null; zone_type: string | null; location_id: string }
interface ImportRow {
  id: string; camera_label: string; status: string; video_count: number; snapshot_count: number; skipped_count: number;
  recorded_from: string | null; recorded_to: string | null; created_at: string; location_id: string;
}
type FileStatus = 'pending' | 'uploading' | 'registering' | 'done' | 'failed';
interface FileProgress { status: FileStatus; sent: number; error?: string }
type RunPhase = 'idle' | 'creating' | 'uploading' | 'done' | 'failed';

const DEVICE_LABELS: Record<DeviceKind, string> = {
  tapo: 'TP-Link Tapo SD card', dahua: 'Dahua DVR/NVR', hikvision: 'Hikvision', reolink: 'Reolink',
  generic_folder: 'Folder of video files', single_file: 'Single video file', unknown: 'Unknown / other',
};
const RESUMABLE_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;
const SNAPSHOT_UPLOAD_CONCURRENCY = 4;
const DEVICE_EVENT_BATCH = 400;

type DirectoryHandle = {
  name: string;
  values: () => AsyncIterable<{ kind: 'file' | 'directory'; name: string; getFile?: () => Promise<File> } & Partial<DirectoryHandle>>;
};

async function walkDirectory(handle: DirectoryHandle, prefix: string, out: ScanInput[]): Promise<void> {
  for await (const entry of handle.values()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file' && entry.getFile) {
      out.push({ file: await entry.getFile(), relativePath });
    } else if (entry.kind === 'directory' && entry.values) {
      await walkDirectory(entry as DirectoryHandle, relativePath, out);
    }
  }
}

function inputsFromFileList(list: FileList): ScanInput[] {
  const inputs: ScanInput[] = [];
  for (const file of Array.from(list)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // The browser prefixes the chosen folder name; the import keeps paths relative to that folder.
    const parts = relative.split('/');
    inputs.push({ file, relativePath: parts.length > 1 ? parts.slice(1).join('/') : relative });
  }
  return inputs;
}

function isAlreadyStored(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /already exists|duplicate|409/i.test(text);
}

function formatWhen(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-NZ', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

const CCTVImportPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const organizationId = profile?.organizationId ?? null;

  const [houses, setHouses] = useState<HouseRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [placesLoading, setPlacesLoading] = useState(true);
  const [placeQuery, setPlaceQuery] = useState('');
  const [houseId, setHouseId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);

  const [cameraLabel, setCameraLabel] = useState('');
  const [deviceKind, setDeviceKind] = useState<DeviceKind>('unknown');
  const [timeZoneChoice, setTimeZoneChoice] = useState(DEFAULT_SOURCE_TIME_ZONE);
  const [customTimeZone, setCustomTimeZone] = useState('');
  const [watermarkHint, setWatermarkHint] = useState('');
  const [notes, setNotes] = useState('');

  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [rawInputs, setRawInputs] = useState<ScanInput[]>([]);
  const [scanned, setScanned] = useState<ScannedFile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [includeSnapshots, setIncludeSnapshots] = useState(true);

  const [phase, setPhase] = useState<RunPhase>('idle');
  const [importRow, setImportRow] = useState<ImportRow | null>(null);
  const [progress, setProgress] = useState<Record<string, FileProgress>>({});
  const [stepMessage, setStepMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentImports, setRecentImports] = useState<ImportRow[]>([]);

  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const activeUploadRef = useRef<TusUpload | null>(null);
  const cancelRef = useRef(false);

  const timeZone = timeZoneChoice === 'custom' ? customTimeZone.trim() : timeZoneChoice;
  const timeZoneValid = isValidTimeZone(timeZone);
  const summary = useMemo(() => summarize(scanned), [scanned]);
  const videos = useMemo(() => scanned.filter((item) => item.kind === 'video'), [scanned]);
  const snapshots = useMemo(() => scanned.filter((item) => item.kind === 'snapshot'), [scanned]);
  const selectedHouse = houses.find((house) => house.id === houseId) ?? null;
  const houseSites = useMemo(() => sites.filter((site) => site.location_id === houseId), [sites, houseId]);
  const houseZones = useMemo(() => zones.filter((zone) => zone.location_id === houseId), [zones, houseId]);
  const filteredHouses = useMemo(() => {
    const query = placeQuery.trim().toLowerCase();
    const list = query
      ? houses.filter((house) => `${house.name} ${house.address ?? ''}`.toLowerCase().includes(query))
      : houses;
    return list.slice(0, 60);
  }, [houses, placeQuery]);
  const busy = phase === 'creating' || phase === 'uploading';

  const loadPlaces = useCallback(async () => {
    setPlacesLoading(true);
    const [houseRes, siteRes, zoneRes] = await Promise.all([
      supabase.from('locations').select('id, name, address, organization_id').order('name'),
      supabase.from('client_sites').select('id, name, address, location_id').eq('active', true).order('name'),
      supabase.from('location_zones').select('id, name, module_key, zone_type, location_id').eq('is_active', true).order('name'),
    ]);
    const failure = houseRes.error ?? siteRes.error ?? zoneRes.error;
    if (failure) setError(failure.message);
    setHouses((houseRes.data as HouseRow[]) ?? []);
    setSites((siteRes.data as SiteRow[]) ?? []);
    setZones((zoneRes.data as ZoneRow[]) ?? []);
    setPlacesLoading(false);
  }, []);

  const loadRecentImports = useCallback(async () => {
    if (!organizationId) return;
    const { data } = await supabase
      .from('cctv_imports')
      .select('id, camera_label, status, video_count, snapshot_count, skipped_count, recorded_from, recorded_to, created_at, location_id')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(8);
    setRecentImports((data as ImportRow[]) ?? []);
  }, [organizationId]);

  useEffect(() => { void loadPlaces(); }, [loadPlaces]);
  useEffect(() => { void loadRecentImports(); }, [loadRecentImports]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Slot times are the camera's wall clock; re-derive them whenever the source zone changes.
  useEffect(() => {
    if (!rawInputs.length || !timeZoneValid) return;
    let cancelled = false;
    setScanning(true);
    void classifyFolder(rawInputs, timeZone).then((result) => {
      if (cancelled) return;
      setScanned(result);
      setScanning(false);
    });
    return () => { cancelled = true; };
  }, [rawInputs, timeZone, timeZoneValid]);

  const acceptInputs = (inputs: ScanInput[], label: string) => {
    setError(null);
    setPhase('idle');
    setImportRow(null);
    setProgress({});
    setFolderLabel(label);
    setRawInputs(inputs);
    const detected = detectDeviceKind(inputs.map((input) => input.relativePath));
    setDeviceKind(detected);
    if (!cameraLabel.trim() && label) setCameraLabel(label.replace(/[_-]+/g, ' ').trim().slice(0, 120));
  };

  const pickFolder = async () => {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (typeof picker !== 'function') {
      folderInputRef.current?.click();
      return;
    }
    try {
      const handle = await picker({ mode: 'read' });
      const inputs: ScanInput[] = [];
      setScanning(true);
      await walkDirectory(handle, '', inputs);
      acceptInputs(inputs, handle.name);
    } catch (pickError) {
      setScanning(false);
      if ((pickError as { name?: string })?.name === 'AbortError') return;
      setError(pickError instanceof Error ? pickError.message : 'The folder could not be read.');
    }
  };

  const onFolderInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    const first = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    acceptInputs(inputsFromFileList(list), first.split('/')[0] || 'Selected folder');
    event.target.value = '';
  };

  const uploadObject = async (file: File, objectName: string, contentType: string, onBytes?: (sent: number) => void): Promise<void> => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (sessionError || !token) throw new Error('Your session has expired. Sign in again before uploading.');
    if (file.size <= RESUMABLE_UPLOAD_THRESHOLD) {
      const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(objectName, file, { contentType, upsert: false });
      if (uploadError && !isAlreadyStored(uploadError)) throw uploadError;
      onBytes?.(file.size);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const upload = new TusUpload(file, {
        endpoint: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/upload/resumable`,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        chunkSize: RESUMABLE_CHUNK_BYTES,
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'x-upsert': 'false',
        },
        metadata: { bucketName: 'bob-uploads', objectName, contentType, cacheControl: '3600' },
        onError: (uploadError) => {
          activeUploadRef.current = null;
          if (isAlreadyStored(uploadError)) { onBytes?.(file.size); resolve(); } else reject(uploadError);
        },
        onProgress: (sent) => onBytes?.(sent),
        onSuccess: () => { activeUploadRef.current = null; resolve(); },
      });
      activeUploadRef.current = upload;
      void upload.findPreviousUploads().then((previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      });
    });
  };

  const setFileProgress = (key: string, patch: Partial<FileProgress>) => {
    setProgress((current) => {
      const previous: FileProgress = current[key] ?? { status: 'pending', sent: 0 };
      return { ...current, [key]: { ...previous, ...patch } };
    });
  };

  const runImport = async (existing: ImportRow | null) => {
    if (!organizationId || !profile?.id) { setError('Sign in with an organisation profile to import footage.'); return; }
    if (!houseId) { setError('Choose the place this camera watches before importing. Cameras carry no GPS.'); return; }
    if (!cameraLabel.trim()) { setError('Give the camera a label (for example “Gate cam 1”).'); return; }
    if (!timeZoneValid) { setError('Enter a valid IANA time zone for the camera clock.'); return; }
    if (videos.length === 0) { setError('No usable video files were found in this folder.'); return; }
    cancelRef.current = false;
    setError(null);
    setPhase('creating');
    let current = existing;
    try {
      if (!current) {
        setStepMessage('Creating the import against the chosen place…');
        const { data, error: createError } = await supabase.rpc('create_cctv_import', {
          p_organization_id: organizationId,
          p_location_id: houseId,
          p_camera_label: cameraLabel.trim(),
          p_site_id: siteId,
          p_zone_id: zoneId,
          p_source_device_kind: deviceKind,
          p_source_timezone: timeZone,
          p_source_root_label: folderLabel,
          p_watermark_location_hint: watermarkHint.trim() || null,
          p_notes: notes.trim() || null,
        });
        if (createError) throw createError;
        current = data as ImportRow;
        setImportRow(current);
        const { error: manifestError } = await supabase.rpc('set_cctv_import_manifest', {
          p_import_id: current.id, p_manifest: buildManifest(scanned), p_status: 'uploading',
        });
        if (manifestError) throw manifestError;
      }
      const importId = current.id;
      setPhase('uploading');

      const snapshotPaths = new Map<string, string>();
      if (includeSnapshots && snapshots.length) {
        setStepMessage(`Uploading ${snapshots.length} camera event snapshots for the timeline…`);
        const queue = snapshots.filter((item) => progress[item.relativePath]?.status !== 'done');
        let index = 0;
        const worker = async () => {
          while (index < queue.length && !cancelRef.current) {
            const item = queue[index];
            index += 1;
            const objectName = storagePathFor(organizationId, importId, item.relativePath);
            try {
              await uploadObject(item.file, objectName, item.file.type || 'image/jpeg');
              snapshotPaths.set(item.relativePath, objectName);
              setFileProgress(item.relativePath, { status: 'done', sent: item.sizeBytes });
            } catch (snapshotError) {
              setFileProgress(item.relativePath, { status: 'failed', error: snapshotError instanceof Error ? snapshotError.message : 'upload failed' });
            }
          }
        };
        await Promise.all(Array.from({ length: SNAPSHOT_UPLOAD_CONCURRENCY }, worker));
      }
      if (cancelRef.current) throw new Error('Import paused. Choose the same folder again to resume.');

      if (snapshots.length) {
        setStepMessage('Recording the camera’s own motion timeline…');
        const events = buildDeviceEvents(scanned, (item) => snapshotPaths.get(item.relativePath) ?? null);
        for (let offset = 0; offset < events.length; offset += DEVICE_EVENT_BATCH) {
          const { error: eventsError } = await supabase.rpc('record_cctv_device_events', {
            p_import_id: importId, p_events: events.slice(offset, offset + DEVICE_EVENT_BATCH),
          });
          if (eventsError) throw eventsError;
        }
      }

      let registered = 0;
      let failed = 0;
      for (const item of videos) {
        if (cancelRef.current) break;
        if (progress[item.relativePath]?.status === 'done') { registered += 1; continue; }
        const objectName = storagePathFor(organizationId, importId, item.relativePath);
        setStepMessage(`Uploading ${item.name} (${formatBytes(item.sizeBytes)})…`);
        setFileProgress(item.relativePath, { status: 'uploading', sent: 0, error: undefined });
        try {
          await uploadObject(item.file, objectName, item.file.type || 'video/mp4', (sent) => setFileProgress(item.relativePath, { sent }));
          setFileProgress(item.relativePath, { status: 'registering', sent: item.sizeBytes });
          const { error: registerError } = await supabase.rpc('register_cctv_import_video', {
            p_import_id: importId,
            p_storage_path: objectName,
            p_file_name: item.name,
            p_file_size_bytes: item.sizeBytes,
            p_sha256: null,
            p_recorded_start_at: item.slotStartAt ?? null,
            p_recorded_end_at: item.slotEndAt ?? null,
            p_source_ref: item.relativePath,
            p_content_type: item.file.type || 'video/mp4',
          });
          if (registerError) throw registerError;
          registered += 1;
          setFileProgress(item.relativePath, { status: 'done' });
        } catch (fileError) {
          failed += 1;
          setFileProgress(item.relativePath, { status: 'failed', error: fileError instanceof Error ? fileError.message : 'upload failed' });
        }
      }
      if (cancelRef.current) throw new Error('Import paused. Choose the same folder again to resume.');
      const finalStatus = registered > 0 ? 'registered' : 'failed';
      await supabase.rpc('set_cctv_import_manifest', { p_import_id: importId, p_manifest: buildManifest(scanned), p_status: finalStatus });
      setStepMessage(failed
        ? `${registered} video${registered === 1 ? '' : 's'} queued for analysis; ${failed} failed. Retry the failed files or choose the folder again later.`
        : `${registered} video${registered === 1 ? '' : 's'} queued for analysis at ${selectedHouse?.name ?? 'the chosen place'}.`);
      setPhase(failed ? 'failed' : 'done');
      void loadRecentImports();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'The import did not complete.');
      setPhase('failed');
    }
  };

  const pauseImport = () => {
    cancelRef.current = true;
    activeUploadRef.current?.abort();
  };

  const totalVideoBytes = summary.videoBytes;
  const sentVideoBytes = videos.reduce((sum, item) => sum + Math.min(item.sizeBytes, progress[item.relativePath]?.sent ?? 0), 0);
  const overallPercent = totalVideoBytes > 0 ? Math.min(100, Math.round((sentVideoBytes / totalVideoBytes) * 100)) : 0;
  const readyToStart = Boolean(houseId && cameraLabel.trim() && timeZoneValid && videos.length > 0 && !busy && !scanning);

  return (
    <div className="cctv-import-page">
      <header className="cctv-import-header">
        <div>
          <span>Field outcomes</span>
          <h1>Import camera footage</h1>
          <p>Bring an SD card or a camera folder into review. The camera’s place comes first — SD cards carry no GPS, and a burnt-in watermark is only a hint.</p>
        </div>
        <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-console')}>
          <Camera size={17} /> Open CCTV review
        </button>
      </header>

      {error && (
        <div className="cctv-import-alert is-error" role="alert">
          <AlertTriangle size={16} /> <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss"><XCircle size={16} /></button>
        </div>
      )}

      <div className="cctv-import-layout">
        <section className="cctv-import-step" aria-labelledby="cctv-import-place">
          <div className="cctv-import-step-heading">
            <span className="cctv-import-step-number">1</span>
            <div>
              <h2 id="cctv-import-place">Where is this camera?</h2>
              <p>Pick the place the camera watches. New places are created in CRM from a LINZ address, never typed here.</p>
            </div>
          </div>
          <label className="cctv-import-search">
            <Search size={15} />
            <input
              type="search"
              value={placeQuery}
              placeholder="Search places by name or address"
              onChange={(event) => setPlaceQuery(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="cctv-import-places" role="listbox" aria-label="Places">
            {placesLoading && <p className="cctv-import-muted">Loading places…</p>}
            {!placesLoading && filteredHouses.length === 0 && (
              <p className="cctv-import-muted">No places match. Places are onboarded in CRM → Locations before footage can be imported.</p>
            )}
            {filteredHouses.map((house) => (
              <button
                key={house.id}
                type="button"
                role="option"
                aria-selected={house.id === houseId}
                className={`cctv-import-place${house.id === houseId ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => { setHouseId(house.id); setSiteId(null); setZoneId(null); }}
              >
                <MapPin size={15} />
                <span>
                  <strong>{house.name}</strong>
                  <small>{house.address ?? 'No street address (area place)'}</small>
                </span>
              </button>
            ))}
          </div>
          {selectedHouse && (houseSites.length > 0 || houseZones.length > 0) && (
            <div className="cctv-import-facets">
              <span>Narrow to a site or zone at {selectedHouse.name} (optional)</span>
              <div>
                {houseSites.map((site) => (
                  <button key={site.id} type="button" className={siteId === site.id ? 'is-selected' : ''} disabled={busy}
                    onClick={() => setSiteId(siteId === site.id ? null : site.id)}>
                    Site · {site.name}
                  </button>
                ))}
                {houseZones.map((zone) => (
                  <button key={zone.id} type="button" className={zoneId === zone.id ? 'is-selected' : ''} disabled={busy}
                    onClick={() => setZoneId(zoneId === zone.id ? null : zone.id)}>
                    Zone · {zone.name}{zone.module_key ? ` (${zone.module_key.replace(/_/g, ' ')})` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="cctv-import-step" aria-labelledby="cctv-import-camera">
          <div className="cctv-import-step-heading">
            <span className="cctv-import-step-number">2</span>
            <div>
              <h2 id="cctv-import-camera">Camera</h2>
              <p>The label names the camera at that place; the clock zone turns file names into real times.</p>
            </div>
          </div>
          <div className="cctv-import-fields">
            <label>
              <span>Camera label</span>
              <input type="text" value={cameraLabel} maxLength={120} placeholder="Gate cam 1" disabled={busy}
                onChange={(event) => setCameraLabel(event.target.value)} />
            </label>
            <label>
              <span>Device</span>
              <select value={deviceKind} disabled={busy} onChange={(event) => setDeviceKind(event.target.value as DeviceKind)}>
                {(Object.keys(DEVICE_LABELS) as DeviceKind[]).map((kind) => <option key={kind} value={kind}>{DEVICE_LABELS[kind]}</option>)}
              </select>
            </label>
            <label>
              <span>Camera clock zone</span>
              <select value={timeZoneChoice} disabled={busy} onChange={(event) => setTimeZoneChoice(event.target.value)}>
                {COMMON_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                <option value="custom">Other…</option>
              </select>
            </label>
            {timeZoneChoice === 'custom' && (
              <label>
                <span>IANA zone name</span>
                <input type="text" value={customTimeZone} placeholder="Pacific/Auckland" disabled={busy}
                  aria-invalid={!timeZoneValid} onChange={(event) => setCustomTimeZone(event.target.value)} />
              </label>
            )}
            <label>
              <span>Location text in the video watermark (hint only)</span>
              <input type="text" value={watermarkHint} maxLength={200} placeholder="e.g. FOREST GATE" disabled={busy}
                onChange={(event) => setWatermarkHint(event.target.value)} />
            </label>
            <label className="cctv-import-wide">
              <span>Notes</span>
              <input type="text" value={notes} maxLength={500} placeholder="Why this card was pulled, who handed it over…" disabled={busy}
                onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>
        </section>

        <section className="cctv-import-step" aria-labelledby="cctv-import-folder">
          <div className="cctv-import-step-heading">
            <span className="cctv-import-step-number">3</span>
            <div>
              <h2 id="cctv-import-folder">Folder</h2>
              <p>Nothing leaves this computer until you start the import. Unused ring slots and device files are recognised and left out.</p>
            </div>
          </div>
          <div className="cctv-import-folder-actions">
            <button type="button" className="page-action" onClick={() => void pickFolder()} disabled={busy || scanning}>
              <FolderOpen size={17} /> {folderLabel ? 'Choose a different folder' : 'Choose SD card or camera folder'}
            </button>
            <input ref={folderInputRef} type="file" multiple hidden onChange={onFolderInput}
              // @ts-expect-error webkitdirectory is a non-standard attribute understood by all major browsers
              webkitdirectory="" />
            {folderLabel && <span className="cctv-import-muted">{folderLabel}{scanning ? ' · scanning…' : ` · ${DEVICE_LABELS[deviceKind]}`}</span>}
          </div>
          {scanned.length > 0 && !scanning && (
            <>
              <dl className="cctv-import-summary">
                <div><dt><FileVideo2 size={14} /> Videos</dt><dd>{summary.videoCount} · {formatBytes(summary.videoBytes)}</dd></div>
                <div><dt>Recorded</dt><dd>{formatWhen(summary.recordedFrom, timeZone)} → {formatWhen(summary.recordedTo, timeZone)}</dd></div>
                <div><dt>Empty slots skipped</dt><dd>{summary.skippedCount}</dd></div>
                <div><dt><Images size={14} /> Event snapshots</dt><dd>{summary.snapshotCount} · {formatBytes(summary.snapshotBytes)}</dd></div>
                <div><dt>Device / other files</dt><dd>{summary.otherCount} left out</dd></div>
              </dl>
              {snapshots.length > 0 && (
                <label className="cctv-import-check">
                  <input type="checkbox" checked={includeSnapshots} disabled={busy} onChange={(event) => setIncludeSnapshots(event.target.checked)} />
                  Upload the camera’s event snapshots ({formatBytes(summary.snapshotBytes)}) so the timeline shows activity before analysis finishes
                </label>
              )}
              <ul className="cctv-import-files">
                {videos.map((item) => {
                  const state = progress[item.relativePath];
                  const percent = state ? Math.min(100, Math.round((state.sent / Math.max(item.sizeBytes, 1)) * 100)) : 0;
                  return (
                    <li key={item.relativePath} className={`is-${state?.status ?? 'pending'}`}>
                      <span className="cctv-import-file-name">{item.relativePath}</span>
                      <span className="cctv-import-file-meta">{formatBytes(item.sizeBytes)} · {formatWhen(item.slotStartAt, timeZone)}</span>
                      <span className="cctv-import-file-state">
                        {state?.status === 'done' && <><CheckCircle2 size={14} /> queued</>}
                        {state?.status === 'failed' && <><XCircle size={14} /> {state.error ?? 'failed'}</>}
                        {state?.status === 'uploading' && `${percent}%`}
                        {state?.status === 'registering' && 'registering…'}
                        {!state && 'ready'}
                      </span>
                      {state?.status === 'uploading' && <progress max={100} value={percent} aria-label={`Upload ${item.name}`} />}
                    </li>
                  );
                })}
                {videos.length === 0 && <li className="is-pending"><span className="cctv-import-file-name">No usable videos found in this folder.</span></li>}
              </ul>
            </>
          )}
        </section>

        <section className="cctv-import-step cctv-import-run" aria-labelledby="cctv-import-start" aria-live="polite">
          <div className="cctv-import-step-heading">
            <span className="cctv-import-step-number">4</span>
            <div>
              <h2 id="cctv-import-start">Start</h2>
              <p>Videos upload one at a time and resume if the connection drops. Each becomes evidence at the chosen place and is queued for analysis.</p>
            </div>
          </div>
          {!readyToStart && !busy && phase === 'idle' && (
            <ul className="cctv-import-checklist">
              <li className={houseId ? 'is-ok' : ''}>{houseId ? <CheckCircle2 size={14} /> : <span className="dot" />} Place chosen</li>
              <li className={cameraLabel.trim() ? 'is-ok' : ''}>{cameraLabel.trim() ? <CheckCircle2 size={14} /> : <span className="dot" />} Camera labelled</li>
              <li className={timeZoneValid ? 'is-ok' : ''}>{timeZoneValid ? <CheckCircle2 size={14} /> : <span className="dot" />} Clock zone valid</li>
              <li className={videos.length ? 'is-ok' : ''}>{videos.length ? <CheckCircle2 size={14} /> : <span className="dot" />} Folder scanned with at least one video</li>
            </ul>
          )}
          {busy && (
            <div className="cctv-import-progress">
              <progress max={100} value={overallPercent} aria-label="Overall upload progress" />
              <span>{overallPercent}% · {formatBytes(sentVideoBytes)} of {formatBytes(totalVideoBytes)}</span>
            </div>
          )}
          {stepMessage && <p className={`cctv-import-status${phase === 'done' ? ' is-done' : ''}`}>{stepMessage}</p>}
          <div className="cctv-import-run-actions">
            {phase !== 'done' && !busy && (
              <button type="button" className="page-action is-primary" disabled={!readyToStart && !(phase === 'failed' && importRow)}
                onClick={() => void runImport(importRow)}>
                <RefreshCw size={16} /> {phase === 'failed' && importRow ? 'Retry failed files' : 'Start import'}
              </button>
            )}
            {busy && (
              <button type="button" className="page-action" onClick={pauseImport}><XCircle size={16} /> Pause</button>
            )}
            {phase === 'done' && importRow && (
              <button type="button" className="page-action is-primary" onClick={() => navigate(`/admin/field-ops?area=cctv-console&import=${importRow.id}`)}>
                <Camera size={16} /> Review this import
              </button>
            )}
          </div>
        </section>
      </div>

      <section className="cctv-import-recent" aria-labelledby="cctv-import-recent-heading">
        <div className="cctv-import-step-heading">
          <div>
            <h2 id="cctv-import-recent-heading">Recent imports</h2>
            <p>Each import stays anchored to its place. Re-choose the same folder to resume one that was paused.</p>
          </div>
        </div>
        {recentImports.length === 0 ? (
          <p className="cctv-import-muted">No camera imports yet for this organisation.</p>
        ) : (
          <table className="cctv-import-table">
            <thead>
              <tr><th>Camera</th><th>Place</th><th>Recorded</th><th>Videos</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {recentImports.map((row) => (
                <tr key={row.id}>
                  <td>{row.camera_label}</td>
                  <td>{houses.find((house) => house.id === row.location_id)?.name ?? '—'}</td>
                  <td>{formatWhen(row.recorded_from, timeZone)}{row.recorded_to ? ` → ${formatWhen(row.recorded_to, timeZone)}` : ''}</td>
                  <td>{row.video_count}{row.skipped_count ? ` (+${row.skipped_count} empty)` : ''}</td>
                  <td><span className={`cctv-import-badge is-${row.status}`}>{row.status.replace(/_/g, ' ')}</span></td>
                  <td>
                    <button type="button" className="cctv-import-link" onClick={() => navigate(`/admin/field-ops?area=cctv-console&import=${row.id}`)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

export default CCTVImportPage;
