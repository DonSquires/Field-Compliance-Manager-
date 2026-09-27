import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: guard-test assertions embed literal '\n' for multi-line patterns, but git on
// Windows checks these source files out as CRLF - an exact substring match would otherwise fail
// even when every individual token it checks for is genuinely present in the file.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const page = read('src/pages/CCTVConsolePage.tsx');
const styles = read('src/pages/CCTVConsolePage.css');
const tile = read('src/components/CCTVPlayerTile.tsx');
const timeline = read('src/components/CCTVTimeline.tsx');
const shell = read('src/shells/AdminShell.tsx');
const fieldOps = read('src/pages/FieldOperationsPage.tsx');
const importPage = read('src/pages/CCTVImportPage.tsx');
const lib = read('src/lib/cctvConsole.ts');

describe('CCTV console', () => {
  it('is driven by the place-anchored CCTV spine, scoped to the organisation', () => {
    expect(page).toContain("from('cctv_imports')");
    expect(page).toContain("locations(name, address)");
    expect(page).toContain("supabase.rpc('get_cctv_console_import_detail'");
    expect(page).toContain("p_import_id: importId");
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(page).toContain("text: 'Organisation access could not be confirmed. The CCTV console is unavailable.'");
  });

  it('explains data-service faults by scope with a retry, and coalesces realtime refresh bursts', () => {
    expect(page).toContain('describeConsoleFailure(');
    expect(page).toContain("'recordings, events and observations for this camera'");
    expect(page).toContain('retry: () => void loadImportDetail(importId)');
    expect(page).toContain('retry: () => void loadImports()');
    expect(page).toContain("setError((current) => (current?.retryable ? null : current));");
    expect(page).toContain('createRefreshCoalescer(loadImportDetail, DETAIL_REFRESH_COALESCE_MS)');
    expect(page).toContain('requestDetailRefresh(importId)');
    expect(page).toContain("window.addEventListener('online', handler)");
    expect(page).toContain('onClick={error.retry}');
    expect(page).not.toMatch(/postgres_changes[\s\S]{0,400}void loadImportDetail\(/);
  });

  it('records every identity decision through the governed review RPC and never writes the table directly', () => {
    expect(page).toContain("supabase.rpc('review_cctv_entity_observation'");
    expect(page).toContain("supabase.rpc('update_cctv_person_profile'");
    expect(page).toContain('p_observation_id: observation.id');
    expect(page).toContain('p_action: action');
    expect(page).not.toMatch(/from\('cctv_entity_observations'\)[\s\S]{0,400}\.(update|insert|delete)\(/);
    expect(page).not.toContain("from('canonical_vehicles')");
    expect(page).not.toContain("from('person_records')");
    expect(page).toContain("'accept_portfolio'");
    expect(page).toContain("'new_person'");
    expect(page).toContain("'new_vehicle'");
    expect(page).toContain("'reject'");
  });

  it('shows the same-or-similar candidates the database found and links through them', () => {
    expect(page).toContain('observation.candidates');
    expect(page).toContain('candidateAction(observation, candidate)');
    expect(page).toContain('Same or similar on record');
  });

  it('shows the inferred person profile and lets a reviewer name and enrich it', () => {
    expect(lib).toContain('person_records(display_name, metadata)');
    expect(lib).toContain("label: kind === 'person' && profileName ? profileName");
    expect(page).toContain('Person name');
    expect(page).toContain('Category');
    expect(page).toContain('Profile details');
    expect(page).toContain('Save person profile');
    expect(page).toContain('if (personDetails.trim()) profileDetails.notes = personDetails.trim();');
    expect(page).toContain('if (personCategory.trim()) profileDetails.category = personCategory.trim();');
    expect(page).toContain('p_profile_details: profileDetails');
  });

  it('lets a reviewer attach a persistent note to the vehicle record, independent of accept/reject, scoped to their own organisation', () => {
    expect(lib).not.toContain('canonical_vehicles(notes)');
    expect(page).toContain('Vehicle note');
    expect(page).toContain('Save vehicle note');
    expect(page).toContain("supabase.rpc('update_cctv_vehicle_notes'");
    expect(page).toContain("supabase.rpc('get_cctv_vehicle_note'");
  });

  it('plays every camera on one shared clock with NVR controls and keyboard shortcuts', () => {
    expect(page).toContain('clockMs');
    expect(page).toContain('isMaster={drivesClock}');
    expect(page).toContain('const clockDriverId = masterItem?.id ?? activeTile?.id ?? null;');
    expect(page).toContain('onTick={handleTick}');
    expect(page).toContain('PLAYBACK_RATES.map');
    expect(page).toContain('GRID_LAYOUTS.map');
    expect(page).toContain("window.addEventListener('keydown', handler)");
    expect(page).toContain('requestFullscreen');
    expect(tile).toContain('clipAtTime(clips, clockMs)');
    expect(tile).toContain('DRIFT_TOLERANCE_SECONDS');
    expect(tile).toContain('video.playbackRate = rate');
    expect(tile).toContain('onClipEnded');
    expect(tile).toContain('Converting this clip for playback');
    expect(tile).toContain('No footage at');
  });

  it('renders photo evidence as a signed still and reports photo-only imports as media', () => {
    expect(page).toContain('selectedImport.snapshot_count} photo');
    expect(page).toContain('row.snapshot_count} photo');
    expect(page).toContain('<strong>Photos &amp; videos</strong>');
    expect(page).toContain('No photos or videos have been registered for this camera yet.');
    expect(page).toContain('Loading camera media…');
    expect(tile).toContain("const mediaIsPhoto = targetClip?.mediaKind === 'photo';");
    expect(tile).toContain('? <img ref={imageRef} src={src ?? undefined}');
    expect(tile).toContain("mediaIsPhoto ? 'Opening photo…' : 'Opening video…'");
  });

  it('lists every recording individually, by day, and lets a reviewer play one alone or several at once on their own clocks', () => {
    expect(page).toContain('groupClipsByDay(selectedClips, timeZone)');
    expect(page).toContain('aria-label={`Recordings from ${selectedImport.camera_label}`}');
    expect(page).toContain('const showRecordingAlone = (clip: ConsoleClip) => replaceWall([clipItem(clip)]);');
    expect(page).toContain('const addRecordingToWall = (clip: ConsoleClip) => placeTile(clipItem(clip));');
    expect(page).toContain('const openDayOnWall = (clips: ConsoleClip[]) => replaceWall(clips.slice(0, 9).map(clipItem));');
    expect(page).toContain("const pinnedClip = item.kind === 'clip' ? clipsById.get(item.evidenceId) ?? null : null;");
    expect(page).toContain('pinnedClip={pinnedClip}');
    expect(page).toContain('clipStatusLabel(clip.jobStatus)');
    expect(page).toContain('bytesLabel(clip.sizeBytes)');
    expect(page).toContain('Recordings on the wall play on their own clocks; the timeline follows the active recording once it has loaded.');
    expect(tile).toContain('const pinned = Boolean(pinnedClip);');
    expect(tile).toContain('const effectivePlaying = playing;');
    expect(page).toContain('Sync clips');
    expect(page).toContain('syncOpenClips');
    expect(tile).toContain('syncTo: (seconds: number) => void;');
    expect(tile).toContain('own clock');
    expect(tile).toContain('React.forwardRef<CCTVPlayerTileHandle');
  });

  it('never selects biometric template columns and explains face matching through the governed readout', () => {
    expect(page).not.toMatch(/select\([^)]*\b(face_vec|appearance_vec|candidate_embedding|appearance_embedding)\b/);
    expect(page).toContain("supabase.rpc('cctv_biometric_governance', { p_organization_id: organizationId })");
    expect(page).toContain('aria-label="Biometric data held by this organisation"');
    expect(page).toContain('Templates are never shown or downloadable. Rejected sightings lose their template at once');
    expect(page).toContain('Rejected still holding one');
  });

  it('shows chain of custody from the governed record, never from browser-held state alone', () => {
    expect(page).toContain("supabase.rpc('cctv_evidence_custody', { p_evidence_id: evidenceId })");
    expect(page).toContain('integrity: parseClipIntegrity(metadata.integrity)');
    expect(page).toContain('custodyBadge(clip)');
    expect(page).toContain('aria-label="Custody record"');
    expect(page).toContain("cctv_evidence_integrity_mismatch: 'Stored bytes did NOT match the recorded hash'");
    expect(page).toContain('Treat this recording as altered until the custodian explains it.');
    expect(page).not.toMatch(/from\('evidence_items'\)[\s\S]{0,300}\.(update|delete)\(/);
    expect(styles).toContain('.cctv-clip__custody.is-mismatch');
    expect(styles).toContain('.cctv-console__custody.is-mismatch { border-color: var(--cc-critical); }');
  });

  it('lets the timeline track and control recordings opened on their own clocks', () => {
    // Recordings on the wall appear on the timeline and bound it.
    expect(page).toContain("if (item.kind !== 'clip' || seen.has(item.evidenceId)) continue;");
    expect(page).toContain('clips={visibleClips}');
    // The active recording drives the playhead; a deliberate seek is distinguishable from a tick.
    expect(page).toContain('setSeekNonce((current) => current + 1);');
    expect(page).toContain('seekNonce={seekNonce}');
    expect(tile).toContain('if (seenSeekNonce.current === seekNonce) return;');
    expect(tile).toContain('if (pinned && (offset < 0 || offset > video.duration)) return;');
    expect(tile).toContain('if (isMaster) onTick(at);');
    expect(tile).not.toContain('if (pinned || !video || !clip');
    // Seeking into another recording hands the clock to that recording.
    expect(page).toContain('if (covering) setActiveTileId(covering.id);');
  });

  it('pops out the camera wall with entities and full-screens only the video review pane', () => {
    expect(page).toContain("const popout = search.get('popout') === '1';");
    expect(page).toContain("new URLSearchParams({ area: 'cctv-console', popout: '1' })");
    expect(page).toContain('window.open(popoutUrl, `fcm-cctv-wall-${selectedImportId ?? \'wall\'}`');
    expect(page).toContain('Pop out wall');
    expect(page).toContain('{!popout ? <aside className="cctv-console__cameras"');
    expect(page).toContain('<aside className="cctv-console__entities" aria-label="Entities seen">');
    expect(page).toContain('<main className="cctv-console__stage" ref={reviewPaneRef} aria-label="Video review pane">');
    expect(page).toContain('reviewPaneRef.current?.requestFullscreen?.()');
    expect(page).not.toContain('gridRef.current?.requestFullscreen?.()');
    expect(styles).toContain('.cctv-console.is-popout');
    // The popped-out wall is a second-monitor surface: the shell drops its own chrome and the grid fills the window.
    expect(shell).toContain("fieldOpsSubArea === 'cctv-console' && new URLSearchParams(location.search).get('popout') === '1'");
    expect(shell).toContain('className="admin-shell admin-shell-video-wall"');
    expect(styles).toContain('.cctv-console.is-popout { display: flex; flex-direction: column; height: 100vh;');
    expect(styles).toContain('.cctv-console.is-popout .cctv-console__layout { flex: 1; grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);');
    expect(styles).toContain('.cctv-console.is-popout .cctv-console__grid-wrap { display: grid; flex: 1; min-height: 0; }');
    expect(styles).toContain('.cctv-console__stage:fullscreen { background: var(--cc-bg); display: flex; flex-direction: column;');
    expect(styles).not.toContain('.cctv-console__grid-wrap:fullscreen');
  });

  it('steps single frames, saves labelled stills and records bookmarks as incidents through the governed RPC', () => {
    expect(page).toContain("case 'frame': stepFrame(action.direction); break;");
    expect(page).toContain('handle.stepFrame(direction)');
    expect(page).toContain('await handle.captureFrame()');
    expect(page).toContain("snapshot.enhanced ? '_ENHANCED-DISPLAY-ONLY' : ''");
    expect(page).toContain("supabase.rpc('create_cctv_bookmark'");
    expect(page).toContain('p_client_request_id: crypto.randomUUID()');
    expect(page).toContain('p_observation_id: bookmarkDraft.observationId');
    expect(page).not.toMatch(/from\('incidents'\)/);
    expect(tile).toContain('FRAME_STEP_SECONDS');
    expect(tile).toContain('captureFrame');
  });

  it('lets only administrators apply an evidence lock, and only over a hashed original, through the governed RPC', () => {
    expect(page).toContain("const isAdmin = ['admin', 'master', 'grand_master'].includes(profile?.role ?? '');");
    expect(page).toContain("supabase.rpc('lock_cctv_evidence'");
    expect(page).toContain('disabled={!activeClip || Boolean(activeClip.lockedAt) || !activeClip.sha256}');
    expect(page).toContain('lockDraft.reason.trim().length < 5');
    expect(page).toContain('sha256_hash: string | null; is_court_ready: boolean | null; locked_at: string | null; retention_hold: boolean | null');
    expect(page).toContain('retention cannot purge it · cannot be undone here');
    expect(page).not.toMatch(/from\('evidence_items'\)[\s\S]{0,400}\.(update|insert|delete)\(/);
  });

  it('gives reviewers non-destructive zoom and image adjustments on the active tile', () => {
    expect(page).toContain('Active tile image inspection');
    expect(page).toContain('cctv-image-adjustments');
    expect(page).toContain('Brightness');
    expect(page).toContain('Contrast');
    expect(page).toContain('Colour');
    expect(page).toContain('Detail');
    expect(page).toContain('nextInspectionZoom(activeInspection.zoom');
    expect(tile).toContain('onInspectionChange');
    expect(tile).toContain('zoomAt(zoomState');
    expect(tile).toContain('panBy(zoomState');
  });

  it('auto-enhances the zoomed picture on the GPU, labels it display-only, and falls back to CSS honestly', () => {
    expect(page).toContain('cycleEnhance');
    expect(page).toContain("activeInspection.enhance === 'auto' ? 'Auto'");
    expect(page).toContain('Enhanced view is display-only; the recording is unchanged.');
    expect(page).toContain('enhancementReadout(enhancementState?.plan ?? null)');
    expect(tile).toContain('crossOrigin="anonymous"');
    expect(tile).toContain('createEnhancementRenderer(canvas)');
    expect(tile).toContain('rendererRef.current?.dispose()');
    expect(tile).toContain('[enhanceRequested, gpuUnavailable, src, clip?.evidenceId]');
    expect(tile).toContain('analyseFramePixels(context.getImageData');
    expect(tile).toContain('estimateNoiseFloor(context.getImageData(0, 0, patch, patch).data, patch, patch)');
    expect(tile).toContain('planEnhancement(stats, { zoom: zoomState.zoom, previous: planRef.current');
    expect(tile).toContain('requestVideoFrameCallback');
    expect(tile).toContain("video.addEventListener('loadeddata', drawAvailableFrame)");
    expect(tile).toContain("video.addEventListener('seeked', drawAvailableFrame)");
    expect(tile).toContain('initialHandle = requestAnimationFrame(drawAvailableFrame)');
    expect(tile).toContain("'Enhanced view' : 'Basic adjustments'");
    expect(tile).toContain('showing basic adjustments instead.');
    expect(tile).toContain('cssFilterFor(plan, manual)');
    expect(styles).toContain('.cctv-tile__body.is-enhanced .cctv-tile__video { visibility: hidden; }');
  });

  it('draws a severity timeline with reviewed entities dimmed and clustered marks', () => {
    expect(timeline).toContain('clusterMarks(marks, view, width)');
    expect(timeline).toContain('SEVERITY_COLOURS[cluster.severity]');
    expect(timeline).toContain("is-reviewed");
    expect(timeline).toContain('onWheel={handleWheel}');
    expect(timeline).toContain('role="slider"');
    expect(page).toContain('alert (plate read / pest)');
  });

  it('signs storage URLs for playback and snapshots instead of exposing paths', () => {
    expect(page).toContain("createSignedUrl(path, SIGNED_URL_TTL_SECONDS)");
    expect(page).toContain("createSignedUrl(mark.thumbnailPath as string, SIGNED_URL_TTL_SECONDS)");
    expect(page).toContain('clip.playbackPath ?? clip.sourcePath');
  });

  it('keeps the header readable against the dark administration workspace', () => {
    expect(styles).toContain('.cctv-console__header .page-title { align-items: center; color: #edf4f5;');
    expect(styles).toContain('.cctv-console__header .page-subtitle { color: #b6c9d0;');
  });

  it('truncates long camera names within the fixed camera rail', () => {
    expect(styles).toContain('.cctv-console__camera-label { color: var(--cc-text); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
  });

  it('sits on the dark administration shell instead of floating light panels inside it', () => {
    expect(styles).toContain('--cc-surface: #0c202b;');
    expect(styles).toContain('--cc-brand: #14c8d4;');
    expect(styles).toContain('.cctv-console__cameras, .cctv-console__entities { background: var(--cc-surface);');
    expect(styles).toContain('.cctv-console__controls { align-items: center; background: var(--cc-surface);');
    expect(styles).not.toMatch(/background: #fff;/);
  });

  it('refreshes an active job when Realtime table publication is unavailable', () => {
    expect(page).toContain('const DETAIL_POLL_INTERVAL_MS = 30_000;');
    expect(page).toContain("clip.jobStatus === 'queued' || clip.jobStatus === 'processing'");
    expect(page).toContain('window.setInterval(() => {');
    expect(page).toContain('for (const importId of activeImportIds) requestDetailRefresh(importId);');
    expect(page).toContain('window.clearInterval(timer)');
  });

  it('is the single Field Operations CCTV entry while subordinate routes remain wired inside the workspace', () => {
    expect(shell).toContain("case 'cctv-console':");
    expect(shell).toContain('<CCTVConsolePage />');
    expect(fieldOps).toContain("area: 'cctv-console', label: 'CCTV & video'");
    expect(fieldOps).not.toContain("area: 'cctv-triage', label:");
    expect(fieldOps).not.toContain("area: 'cctv-review', label:");
    expect(importPage).toContain('/admin/field-ops?area=cctv-console&import=${importRow.id}');
    expect(page).toContain("const requestedImportId = search.get('import');");
    expect(page).toContain("navigate('/admin/field-ops?area=cctv-review')");
    expect(page).toContain("navigate('/admin/field-ops?area=cctv-import')");
  });

  it('keeps every state honest: loading, empty, running inference, all reviewed', () => {
    expect(page).toContain('No camera footage has been imported yet');
    expect(page).toContain('Inference is still running on this footage');
    expect(page).toContain('Everything here has been reviewed');
    expect(page).toContain('No people, vehicles or animals were reported for this footage.');
    expect(page).toContain('Loading the camera’s timeline');
  });

  it('labels weak AI output as a candidate and retains the governed rejection path', () => {
    expect(page).toContain('inferenceReviewLabel(observation)');
    expect(page).toContain('isWeakInferenceCandidate(observation)');
    expect(page).toContain('Not a {observation.kind}');
  });
});
