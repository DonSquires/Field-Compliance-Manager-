use base64::Engine;
use fcm_dhfs::{AlignedFileSource, Catalog, ExtractedClip, LocationMethod, Volume, DEVICE_READ_ALIGNMENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};
use tauri::Emitter;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeviceCandidate { id: String, label: String, size_bytes: u64, removable: bool, read_only: bool, partitions: u32, partition_style: String, bus_type: String, drive_letters: Vec<String>, offline: bool }

/// Emitted as `acquisition-progress` while a card is being cloned and while the clone is re-read for verification.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AcquisitionProgress { source_id: String, stage: &'static str, bytes_done: u64, total_bytes: u64, elapsed_seconds: f64, bytes_per_second: f64, eta_seconds: Option<f64> }

static ACQUISITION_CANCELLED: AtomicBool = AtomicBool::new(false);
const ACQUISITION_CHUNK: usize = 4 * 1024 * 1024;
const PROGRESS_EVERY_BYTES: u64 = 256 * 1024 * 1024;

/// What the first sectors of a device look like, so a card that is not recognised can be described
/// precisely instead of guessed at. Read-only; nothing is interpreted beyond the MBR and the DHFS locate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceProbe { id: String, size_bytes: u64, sector0_hex: String, sector0_ascii: String, mbr_signature: bool, mbr_partitions: Vec<String>, dhfs_magic_at_zero: bool, dhfs_dpt_marker_within_first_mib: Option<u64>, dhfs_location: Option<String>, dhfs_error: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcquisitionReceipt { source_id: String, image_path: String, bytes_copied: u64, source_sha256: String, image_sha256: String, verified: bool, read_errors: u32 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Adapter { name: String, state: String, confidence: String, detail: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionResult { image_bytes: u64, signatures: Vec<String>, candidate_offsets: Vec<u64>, adapters: Vec<Adapter>, dhfs: Option<Volume>, dhfs_error: Option<String> }

/// Where DHFS bytes should be read from. The verified image is the evidence path; a direct card
/// read exists because cloning a 128 GB card takes longer than a field operator has when they only
/// need to confirm what the card holds. Both paths open the source read-only.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum DhfsSourceSpec {
    Image { path: String },
    Device { id: String, #[serde(default)] size_bytes: u64 },
}

impl DhfsSourceSpec {
    fn label(&self) -> &'static str { match self { DhfsSourceSpec::Image { .. } => "image", DhfsSourceSpec::Device { .. } => "card" } }
}

fn is_physical_drive_id(id: &str) -> bool {
    id.strip_prefix("PhysicalDrive").map(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
}

/// Windows raw-device errors in words a field operator can act on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn explain_device_error(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(5) => format!("{error}. Windows only lets an administrator read a whole disk: close FCM Desktop V2, right-click it and choose 'Run as administrator', then discover the card again."),
        Some(32) => format!("{error}. Another program holds the card open (often Explorer's 'You need to format the disk' prompt, a backup tool or antivirus). Close it and try again."),
        Some(21) | Some(1167) => format!("{error}. Windows says the device is not ready: reseat the card in the reader and discover again."),
        Some(87) | Some(27) => format!("{error}. The read fell outside the sectors Windows will serve; the reported disk size may be wrong for this reader."),
        _ => error.to_string(),
    }
}

fn open_source(spec: &DhfsSourceSpec) -> Result<AlignedFileSource, String> {
    match spec {
        DhfsSourceSpec::Image { path } => AlignedFileSource::open_image(Path::new(path)).map_err(|error| error.to_string()),
        DhfsSourceSpec::Device { id, size_bytes } => {
            if !is_physical_drive_id(id) { return Err("Only a discovered removable physical device can be read.".to_string()); }
            #[cfg(target_os = "windows")]
            {
                let device_path = format!(r"\\.\{id}");
                let file = OpenOptions::new().read(true).write(false).open(&device_path)
                    .map_err(|error| format!("Could not open {device_path} read-only: {}", explain_device_error(&error)))?;
                Ok(AlignedFileSource::from_file(file, Some(*size_bytes), DEVICE_READ_ALIGNMENT))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (size_bytes, DEVICE_READ_ALIGNMENT);
                Err("Direct card reads are available in the Windows FCM Desktop V2 build.".to_string())
            }
        }
    }
}

/// Every disk Windows knows about except the ones it is running from. Built-in laptop card readers
/// report bus types such as SD, MMC, USB, SCSI or Unknown depending on the driver, so filtering on the
/// bus type hid real cards; the drive letters are listed so "my D: drive" maps to a PhysicalDrive.
const DISCOVERY_SCRIPT: &str = r#"$ErrorActionPreference='SilentlyContinue'; $disks = Get-Disk | Where-Object { -not $_.IsBoot -and -not $_.IsSystem } | ForEach-Object { $d = $_; $letters = @(Get-Partition -DiskNumber $d.Number | Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter):" }); [pscustomobject]@{ Number = [int]$d.Number; FriendlyName = [string]$d.FriendlyName; Size = [uint64]$d.Size; BusType = [string]$d.BusType; PartitionStyle = [string]$d.PartitionStyle; NumberOfPartitions = [int]$d.NumberOfPartitions; IsReadOnly = [bool]$d.IsReadOnly; IsOffline = [bool]$d.IsOffline; DriveLetters = $letters } }; ConvertTo-Json -Compress -Depth 3 @($disks)"#;

#[tauri::command(async)]
fn discover_read_only_devices() -> Result<Vec<DeviceCandidate>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", DISCOVERY_SCRIPT]).output().map_err(|e| format!("PowerShell could not be started to list disks: {e}"))?;
        if !output.status.success() { return Err(format!("Disk discovery failed: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        if output.stdout.iter().all(|byte| byte.is_ascii_whitespace()) { return Ok(Vec::new()); }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Disk list was not readable: {e}"))?;
        let rows = if value.is_array() { value.as_array().cloned().unwrap_or_default() } else { vec![value] };
        let mut devices: Vec<DeviceCandidate> = rows.into_iter().enumerate().map(|(index, row)| {
            let bus_type = row.get("BusType").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
            DeviceCandidate {
                id: row.get("Number").and_then(|v| v.as_u64()).map(|n| format!("PhysicalDrive{n}")).unwrap_or_else(|| format!("removable-{index}")),
                label: row.get("FriendlyName").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or("Removable camera media").to_string(),
                size_bytes: row.get("Size").and_then(|v| v.as_u64()).unwrap_or(0),
                removable: matches!(bus_type.as_str(), "USB" | "SD" | "MMC"),
                read_only: true,
                partitions: row.get("NumberOfPartitions").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                partition_style: row.get("PartitionStyle").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
                bus_type,
                drive_letters: row.get("DriveLetters").and_then(|v| v.as_array()).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                offline: row.get("IsOffline").and_then(|v| v.as_bool()).unwrap_or(false),
            }
        }).collect();
        // Removable buses first, then smallest disks: a camera card is rarely the biggest thing attached.
        devices.sort_by(|a, b| b.removable.cmp(&a.removable).then(a.size_bytes.cmp(&b.size_bytes)));
        return Ok(devices);
    }
    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

/// Describe the first sectors of a discovered device and where (if anywhere) the DHFS volume is.
#[tauri::command(async)]
fn probe_device(id: String, size_bytes: u64) -> Result<DeviceProbe, String> {
    let mut source = open_source(&DhfsSourceSpec::Device { id: id.clone(), size_bytes })?;
    let mut sector0 = vec![0_u8; 512];
    fcm_dhfs::BlockSource::read_at(&mut source, 0, &mut sector0).map_err(|error| error.to_string())?;
    let mbr_signature = sector0[510] == 0x55 && sector0[511] == 0xaa;
    let mbr_partitions = if mbr_signature {
        (0..4).filter_map(|index| {
            let entry = &sector0[446 + index * 16..446 + index * 16 + 16];
            let type_code = entry[4];
            let first_lba = u32::from_le_bytes(entry[8..12].try_into().expect("four bytes"));
            let sectors = u32::from_le_bytes(entry[12..16].try_into().expect("four bytes"));
            (type_code != 0 || first_lba != 0).then(|| format!("entry {}: type 0x{type_code:02x}, first LBA {first_lba}, {} MiB", index + 1, sectors as u64 * 512 / (1024 * 1024)))
        }).collect()
    } else { Vec::new() };
    let mut first_mib = vec![0_u8; 1024 * 1024];
    let dpt = fcm_dhfs::BlockSource::read_at(&mut source, 0, &mut first_mib).ok()
        .and_then(|_| first_mib.windows(fcm_dhfs::DPT_MARKER.len()).position(|window| window == fcm_dhfs::DPT_MARKER).map(|position| position as u64));
    let (dhfs_location, dhfs_error) = match fcm_dhfs::open_volume(&mut source) {
        Ok(volume) => (Some(format!("DHFS4.1 at byte {} ({}), {} partition(s)", volume.location.base_offset, location_label(&volume), volume.partitions.len())), None),
        Err(error) => (None, Some(error.to_string())),
    };
    Ok(DeviceProbe {
        id, size_bytes,
        sector0_hex: sector0[..64].iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" "),
        sector0_ascii: sector0[..64].iter().map(|&byte| if (0x20..0x7f).contains(&byte) { byte as char } else { '.' }).collect(),
        mbr_signature, mbr_partitions,
        dhfs_magic_at_zero: sector0.starts_with(fcm_dhfs::MAGIC),
        dhfs_dpt_marker_within_first_mib: dpt,
        dhfs_location, dhfs_error,
    })
}

fn progress_event(source_id: &str, stage: &'static str, bytes_done: u64, total_bytes: u64, started: Instant) -> AcquisitionProgress {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let rate = bytes_done as f64 / elapsed;
    let eta = (total_bytes > bytes_done && rate > 0.0).then(|| (total_bytes - bytes_done) as f64 / rate);
    AcquisitionProgress { source_id: source_id.to_string(), stage, bytes_done, total_bytes, elapsed_seconds: elapsed, bytes_per_second: rate, eta_seconds: eta }
}

/// Raw disks reject reads that are not sector multiples and answer the very end with an error rather than 0.
fn is_end_of_device(error: &std::io::Error, copied: u64, expected: u64) -> bool {
    expected > 0 && copied >= expected || matches!(error.raw_os_error(), Some(27) | Some(38) | Some(87) | Some(1117)) && copied > 0 && (expected == 0 || copied + DEVICE_READ_ALIGNMENT > expected)
}

#[tauri::command]
fn cancel_acquisition() {
    ACQUISITION_CANCELLED.store(true, Ordering::SeqCst);
}

/// Clone the whole card into an immutable image with progress events. Runs off the main thread: a 128 GB card
/// over USB takes 20–60 minutes and the window must stay responsive throughout.
#[tauri::command(async)]
fn acquire_read_only_device_image(app: tauri::AppHandle, source_id: String, destination_path: String, size_bytes: u64) -> Result<AcquisitionReceipt, String> {
    if !is_physical_drive_id(&source_id) { return Err("Only a discovered removable physical device can be acquired.".to_string()); }
    #[cfg(target_os = "windows")]
    {
        ACQUISITION_CANCELLED.store(false, Ordering::SeqCst);
        let source_path = format!(r"\\.\{}", source_id);
        let mut source = OpenOptions::new().read(true).write(false).open(&source_path).map_err(|e| format!("Could not open source read-only: {}", explain_device_error(&e)))?;
        let destination = Path::new(&destination_path);
        if destination.exists() { return Err("The destination already exists. Choose a new acquisition path; existing evidence will not be overwritten.".to_string()); }
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|e| format!("Could not create acquisition directory: {e}"))?; }
        if size_bytes > 0 {
            let free = destination.parent().filter(|p| p.as_os_str().len() > 0).map(fs2::available_space).unwrap_or_else(|| fs2::available_space(destination));
            if let Ok(free) = free {
                if free < size_bytes + 64 * 1024 * 1024 {
                    // Same unit the interface uses (GiB), and the reason the whole card counts: an exact image copies empty space too.
                    return Err(format!(
                        "Not enough free space for an exact image: it is the whole card, {:.1} GB including unused space, but only {:.1} GB is free on {}. Either choose a drive with at least {:.1} GB free, or skip the image and use \"List recordings directly from card\" then extract only the recordings you need.",
                        size_bytes as f64 / 1073741824.0, free as f64 / 1073741824.0,
                        destination.parent().map(|p| p.display().to_string()).unwrap_or_default(),
                        (size_bytes + 64 * 1024 * 1024) as f64 / 1073741824.0
                    ));
                }
            }
        }
        let partial_path = destination.with_extension("img.part");
        let mut image = OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|e| format!("Could not create temporary image: {e}"))?;
        let mut source_hash = Sha256::new(); let mut image_hash = Sha256::new(); let mut total = 0_u64; let mut buffer = vec![0_u8; ACQUISITION_CHUNK];
        let started = Instant::now(); let mut last_report = 0_u64;
        let _ = app.emit("acquisition-progress", progress_event(&source_id, "cloning", 0, size_bytes, started));
        loop {
            if ACQUISITION_CANCELLED.load(Ordering::SeqCst) {
                drop(image); let _ = fs::remove_file(&partial_path);
                return Err(format!("Acquisition cancelled after {:.1} GB; the partial image was deleted and the card was not modified.", total as f64 / 1e9));
            }
            let mut want = buffer.len();
            if size_bytes > 0 {
                let remaining = size_bytes - total;
                if remaining == 0 { break; }
                want = want.min(remaining as usize);
                if want >= DEVICE_READ_ALIGNMENT as usize { want -= want % DEVICE_READ_ALIGNMENT as usize; } else { want -= want % 512; }
                if want == 0 { break; }
            }
            let count = match source.read(&mut buffer[..want]) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if is_end_of_device(&error, total, size_bytes) => break,
                Err(error) => { drop(image); let _ = fs::remove_file(&partial_path); return Err(format!("Read failed after {:.1} GB: {}", total as f64 / 1e9, explain_device_error(&error))); }
            };
            image.write_all(&buffer[..count]).map_err(|e| format!("Could not write the image after {:.1} GB: {e}", total as f64 / 1e9))?;
            source_hash.update(&buffer[..count]); image_hash.update(&buffer[..count]); total += count as u64;
            if total - last_report >= PROGRESS_EVERY_BYTES { last_report = total; let _ = app.emit("acquisition-progress", progress_event(&source_id, "cloning", total, size_bytes, started)); }
        }
        image.flush().map_err(|e| e.to_string())?; image.sync_all().map_err(|e| e.to_string())?;
        drop(image);
        fs::rename(&partial_path, destination).map_err(|e| format!("Could not commit verified image atomically: {e}"))?;
        let verify_started = Instant::now();
        let _ = app.emit("acquisition-progress", progress_event(&source_id, "verifying", 0, total, verify_started));
        let mut verifier = File::open(destination).map_err(|e| format!("Could not reopen image for verification: {e}"))?;
        let mut verify_hash = Sha256::new(); let mut verified_bytes = 0_u64; last_report = 0;
        loop {
            let count = verifier.read(&mut buffer).map_err(|e| format!("Verification read failed: {e}"))?;
            if count == 0 { break; }
            verify_hash.update(&buffer[..count]); verified_bytes += count as u64;
            if verified_bytes - last_report >= PROGRESS_EVERY_BYTES { last_report = verified_bytes; let _ = app.emit("acquisition-progress", progress_event(&source_id, "verifying", verified_bytes, total, verify_started)); }
        }
        let image_sha256 = format!("{:x}", verify_hash.finalize());
        let source_sha256 = format!("{:x}", source_hash.finalize());
        let verified = verified_bytes == total && image_sha256 == format!("{:x}", image_hash.finalize()) && image_sha256 == source_sha256;
        let _ = app.emit("acquisition-progress", progress_event(&source_id, if verified { "complete" } else { "mismatch" }, verified_bytes, total, verify_started));
        return Ok(AcquisitionReceipt { source_id, image_path: destination_path, bytes_copied: total, source_sha256, image_sha256, verified, read_errors: 0 });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, destination_path, size_bytes);
        Err("Whole-device acquisition is implemented for the Windows desktop prototype.".to_string())
    }
}

fn location_label(volume: &Volume) -> String {
    match &volume.location.method {
        LocationMethod::DeviceStart => "raw device, no partition table".to_string(),
        LocationMethod::MbrPartition { index, type_code, .. } => format!("MBR partition {} type 0x{type_code:02x}, shown as RAW by Windows", index + 1),
        LocationMethod::GptPartition { index, .. } => format!("GPT partition {}", index + 1),
        LocationMethod::Scan => "found by sector scan".to_string(),
    }
}

#[tauri::command(async)]
fn inspect_acquisition_image(image_path: String) -> Result<InspectionResult, String> {
    let mut file = File::open(&image_path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let scan_bytes = metadata.len().min(16 * 1024 * 1024) as usize;
    let mut buffer = vec![0_u8; scan_bytes]; file.read_exact(&mut buffer).map_err(|e| e.to_string())?;
    let mut signatures = Vec::new(); let mut offsets = Vec::new();
    for (needle, label) in [(b"DHFS4.1".as_slice(), "DHFS4.1"), (b"DHFS_DPT:".as_slice(), "DHFS DPT"), (b"DHAV".as_slice(), "DHAV frame"), (b"fat32".as_slice(), "FAT32 marker"), (b"exfat".as_slice(), "exFAT marker"), (b"ftyp".as_slice(), "MP4 container")].iter() {
        if let Some(index) = buffer.windows(needle.len()).position(|window| window.eq_ignore_ascii_case(needle)) { signatures.push((*label).to_string()); offsets.push(index as u64); }
    }
    drop(file);

    // The signature scan only says "DHFS bytes exist somewhere"; the volume walk says where the
    // hidden partition starts, how it is laid out, and whether it can be trusted.
    let mut source = AlignedFileSource::open_image(Path::new(&image_path)).map_err(|error| error.to_string())?;
    let (dhfs, dhfs_error) = match fcm_dhfs::open_volume(&mut source) {
        Ok(volume) => (Some(volume), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let dhfs_detail = match (&dhfs, &dhfs_error) {
        (Some(volume), _) => {
            let partition = &volume.partitions[0];
            let range = match (partition.first_date, partition.last_date) {
                (Some(first), Some(last)) => format!(" Recordings {first} to {last}."),
                _ => String::new(),
            };
            format!(
                "DHFS4.1 volume at byte {} ({}). {} partition{}, {} B blocks, {} MiB fragments, {} descriptors.{}",
                volume.location.base_offset, location_label(volume), volume.partitions.len(), if volume.partitions.len() == 1 { "" } else { "s" },
                partition.block_size, partition.fragment_size / (1024 * 1024), partition.descriptor_count, range
            )
        }
        (None, Some(error)) => error.clone(),
        (None, None) => "No DHFS volume.".to_string(),
    };
    let has_dhfs = dhfs.is_some();
    let dhfs_state = if has_dhfs { "identified" } else if signatures.iter().any(|s| s.starts_with("DHFS")) { "ambiguous" } else { "absent" };
    let adapters = vec![
        Adapter { name: "DHFS adapter".into(), state: dhfs_state.into(), confidence: if has_dhfs { "high" } else { "low" }.into(), detail: dhfs_detail },
        Adapter { name: "Generic filesystem adapter".into(), state: if signatures.iter().any(|s| s.contains("FAT") || s.contains("MP4")) { "identified" } else { "ambiguous" }.into(), confidence: "medium".into(), detail: if has_dhfs { "Not needed: the DHFS adapter owns this source." } else { "FAT/exFAT or MP4 markers decide whether this card is a consumer-camera dump." }.into() },
        Adapter { name: "Raw video signature scanner".into(), state: "ambiguous".into(), confidence: "medium".into(), detail: "Candidate offsets preserved for codec-specific inspection.".into() },
    ];
    Ok(InspectionResult { image_bytes: metadata.len(), signatures, candidate_offsets: offsets, adapters, dhfs, dhfs_error })
}

/// Locate the hidden DHFS partition and list every recording it holds, from an image or the card.
#[tauri::command(async)]
fn read_dhfs_catalog(source: DhfsSourceSpec) -> Result<Catalog, String> {
    let mut block_source = open_source(&source)?;
    fcm_dhfs::catalog(&mut block_source).map_err(|error| error.to_string())
}

/// Copy one recording out of the volume into `destination_directory` (atomic, hashed, never overwrites).
/// With `reuse_existing`, a finished copy already in the folder is re-hashed and returned instead of refused,
/// so sending can resume after the app was closed without stitching the recording twice.
#[tauri::command(async)]
fn extract_dhfs_recording(source: DhfsSourceSpec, partition_index: u32, descriptor: u32, destination_directory: String, reuse_existing: Option<bool>) -> Result<ExtractedClip, String> {
    let mut block_source = open_source(&source)?;
    let catalog = fcm_dhfs::catalog(&mut block_source).map_err(|error| error.to_string())?;
    let recording = catalog.recordings.iter()
        .find(|recording| recording.partition_index == partition_index && recording.descriptor == descriptor)
        .ok_or("That recording is no longer present on the source. Re-read the catalog before extracting.")?;
    if reuse_existing.unwrap_or(false) {
        if let Some(clip) = fcm_dhfs::existing_extracted_clip(recording, Path::new(&destination_directory), source.label()).map_err(|error| error.to_string())? {
            return Ok(clip);
        }
    }
    fcm_dhfs::extract_recording_to_directory(&mut block_source, &catalog.volume, recording, Path::new(&destination_directory), source.label())
        .map_err(|error| error.to_string())
}

/// Where extracted recordings are spooled before they are sent: a per-card folder the operator never has to
/// choose. Public Documents so a second Windows account on the same laptop can still find the evidence copy.
#[tauri::command]
fn default_clip_directory(source_id: String) -> Result<String, String> {
    let safe: String = source_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let base = std::env::var_os("PUBLIC").map(PathBuf::from).filter(|p| p.is_absolute())
        .map(|p| p.join("Documents"))
        .unwrap_or_else(std::env::temp_dir);
    let directory = base.join("fcm-acquisitions").join(if safe.is_empty() { "card".to_string() } else { safe });
    fs::create_dir_all(&directory).map_err(|error| format!("Could not create the working folder {}: {error}", directory.display()))?;
    Ok(directory.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------------------------
// Sending recordings to FCM: resumable upload (tus) into the tenant's bob-uploads prefix
// ---------------------------------------------------------------------------------------------

/// The web app's own contract: 6 MiB chunks are the size Supabase's resumable endpoint accepts.
const TUS_CHUNK: usize = 6 * 1024 * 1024;
const TUS_MAX_RETRIES: u32 = 5;
static UPLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTarget { supabase_url: String, api_key: String, access_token: String, bucket: String, object_name: String, content_type: String }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProgress { upload_id: String, bytes_sent: u64, total_bytes: u64, elapsed_seconds: f64, bytes_per_second: f64 }

/// `unauthorized` hands the resumable URL back so the interface can refresh the session and continue
/// from the same offset instead of starting a 2 GB recording again.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadOutcome { status: &'static str, upload_url: Option<String>, bytes_sent: u64, total_bytes: u64 }

fn tus_metadata(target: &UploadTarget) -> String {
    let b64 = |value: &str| base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    format!("bucketName {},objectName {},contentType {},cacheControl {}", b64(&target.bucket), b64(&target.object_name), b64(&target.content_type), b64("3600"))
}

fn tus_request(agent: &ureq::Agent, method: &str, url: &str, target: &UploadTarget) -> ureq::Request {
    agent.request(method, url)
        .set("Tus-Resumable", "1.0.0")
        .set("Authorization", &format!("Bearer {}", target.access_token))
        .set("apikey", &target.api_key)
}

fn absolute_upload_url(location: &str, supabase_url: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") { location.to_string() }
    else { format!("{}/{}", supabase_url.trim_end_matches('/'), location.trim_start_matches('/')) }
}

fn tus_offset(agent: &ureq::Agent, upload_url: &str, target: &UploadTarget) -> Result<u64, String> {
    let response = tus_request(agent, "HEAD", upload_url, target).call().map_err(|error| format!("Could not ask the server where the upload stopped: {}", describe_http_error(error)))?;
    response.header("Upload-Offset").and_then(|value| value.trim().parse::<u64>().ok()).ok_or_else(|| "The server did not report an upload offset.".to_string())
}

fn describe_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body).ok()
                .and_then(|value| value.get("message").or_else(|| value.get("error")).and_then(|m| m.as_str()).map(str::to_string))
                .unwrap_or_else(|| body.chars().take(200).collect());
            format!("HTTP {code}{}", if detail.is_empty() { String::new() } else { format!(": {detail}") })
        }
        ureq::Error::Transport(transport) => format!("network: {transport}"),
    }
}

#[tauri::command]
fn cancel_upload() {
    UPLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

/// Send one extracted recording into FCM storage with the tus resumable protocol, exactly as the web import
/// page does for large files. Runs off the main thread and reports progress per chunk.
#[tauri::command(async)]
fn upload_clip_resumable(app: tauri::AppHandle, upload_id: String, clip_path: String, target: UploadTarget, resume_url: Option<String>) -> Result<UploadOutcome, String> {
    UPLOAD_CANCELLED.store(false, Ordering::SeqCst);
    if !target.object_name.starts_with("org/") || target.object_name.contains("..") { return Err("Uploads go only under the organisation's own cctv prefix.".to_string()); }
    let mut file = File::open(&clip_path).map_err(|error| format!("Could not open the extracted recording: {error}"))?;
    let total_bytes = file.metadata().map_err(|error| error.to_string())?.len();
    if total_bytes == 0 { return Err("The extracted recording is empty; extract it again before sending.".to_string()); }
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(180)).timeout_write(Duration::from_secs(180)).build();
    let started = Instant::now();

    let upload_url = match resume_url {
        Some(url) => url,
        None => {
            let created = tus_request(&agent, "POST", &format!("{}/storage/v1/upload/resumable", target.supabase_url.trim_end_matches('/')), &target)
                .set("Upload-Length", &total_bytes.to_string())
                .set("Upload-Metadata", &tus_metadata(&target))
                .set("x-upsert", "false")
                .call();
            match created {
                Ok(response) => {
                    let location = response.header("Location").ok_or_else(|| "The server accepted the upload but gave no resumable location.".to_string())?;
                    absolute_upload_url(location, &target.supabase_url)
                }
                // Same object already stored: registration is idempotent, so this is success, not a retry.
                Err(ureq::Error::Status(409, _)) => return Ok(UploadOutcome { status: "exists", upload_url: None, bytes_sent: total_bytes, total_bytes }),
                Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => return Ok(UploadOutcome { status: "unauthorized", upload_url: None, bytes_sent: 0, total_bytes }),
                Err(error) => return Err(format!("FCM storage refused to start the upload: {}", describe_http_error(error))),
            }
        }
    };

    let mut offset = tus_offset(&agent, &upload_url, &target)?;
    let mut buffer = vec![0_u8; TUS_CHUNK];
    let mut retries = 0_u32;
    let _ = app.emit("upload-progress", UploadProgress { upload_id: upload_id.clone(), bytes_sent: offset, total_bytes, elapsed_seconds: 0.0, bytes_per_second: 0.0 });
    while offset < total_bytes {
        if UPLOAD_CANCELLED.load(Ordering::SeqCst) {
            return Err(format!("Sending cancelled at {:.1} MB of {:.1} MB; the recording on the card and the extracted copy are untouched.", offset as f64 / 1048576.0, total_bytes as f64 / 1048576.0));
        }
        let want = ((total_bytes - offset) as usize).min(TUS_CHUNK);
        file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
        file.read_exact(&mut buffer[..want]).map_err(|error| format!("Could not read the extracted recording at byte {offset}: {error}"))?;
        let patched = tus_request(&agent, "PATCH", &upload_url, &target)
            .set("Upload-Offset", &offset.to_string())
            .set("Content-Type", "application/offset+octet-stream")
            .send_bytes(&buffer[..want]);
        match patched {
            Ok(response) => {
                offset = response.header("Upload-Offset").and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(offset + want as u64);
                retries = 0;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let _ = app.emit("upload-progress", UploadProgress { upload_id: upload_id.clone(), bytes_sent: offset, total_bytes, elapsed_seconds: elapsed, bytes_per_second: offset as f64 / elapsed });
            }
            Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
                return Ok(UploadOutcome { status: "unauthorized", upload_url: Some(upload_url), bytes_sent: offset, total_bytes });
            }
            // tus answers a stale Upload-Offset with 409 too; only a duplicate-object 409 means the bytes are already there.
            Err(ureq::Error::Status(409, response)) => {
                let body = response.into_string().unwrap_or_default();
                if body.contains("already exists") || body.contains("Duplicate") {
                    return Ok(UploadOutcome { status: "exists", upload_url: Some(upload_url), bytes_sent: total_bytes, total_bytes });
                }
                retries += 1;
                if retries > TUS_MAX_RETRIES { return Err(format!("The server and this upload disagree about the offset after {TUS_MAX_RETRIES} attempts: {}", body.chars().take(200).collect::<String>())); }
                offset = tus_offset(&agent, &upload_url, &target)?;
            }
            Err(error) => {
                retries += 1;
                if retries > TUS_MAX_RETRIES { return Err(format!("Sending failed after {TUS_MAX_RETRIES} retries at {:.1} MB: {}. Choose “Send” again to resume from where it stopped.", offset as f64 / 1048576.0, describe_http_error(error))); }
                std::thread::sleep(Duration::from_millis(500 * 2_u64.pow(retries.min(4))));
                offset = tus_offset(&agent, &upload_url, &target).unwrap_or(offset);
            }
        }
    }
    Ok(UploadOutcome { status: "complete", upload_url: Some(upload_url), bytes_sent: offset, total_bytes })
}

// ---------------------------------------------------------------------------------------------
// Review here: the on-demand decoder sidecar, filmstrips and preview renditions
// ---------------------------------------------------------------------------------------------

use tauri::Manager;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DecoderProgress { bytes_done: u64, total_bytes: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilmstripFrame { at_seconds: f64, jpeg_base64: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Filmstrip { frames: Vec<FilmstripFrame>, key_frames_used: u32 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRendition { path: String, bytes: u64, encoder: Option<fcm_decoder::PreviewEncoder>, seconds: f64, cached: bool }

fn app_local_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|error| format!("The app's local data folder is not available: {error}"))
}

fn verified_ffmpeg(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = fcm_decoder::ffmpeg_path(&app_local_data(app)?);
    let mut file = File::open(&path).map_err(|_| "The decoder is not installed. Install it under “Review here” first.".to_string())?;
    let digest = fcm_decoder::sha256_of(&mut file).map_err(|error| error.to_string())?;
    if digest != fcm_decoder::FFMPEG_SHA256 { return Err(format!("The installed decoder does not match the pinned build ({}…); it will not be used. Install it again.", &digest[..12])); }
    Ok(path)
}

/// Whether the pinned decoder is present and matches its hash. Never trusts a file by name alone.
#[tauri::command(async)]
fn decoder_status(app: tauri::AppHandle) -> Result<fcm_decoder::DecoderStatus, String> {
    let path = fcm_decoder::ffmpeg_path(&app_local_data(&app)?);
    let (installed, rejected_reason) = match File::open(&path) {
        Ok(mut file) => match fcm_decoder::sha256_of(&mut file) {
            Ok(digest) if digest == fcm_decoder::FFMPEG_SHA256 => (true, None),
            Ok(digest) => (false, Some(format!("present but hash {}… does not match the pinned build", &digest[..12]))),
            Err(error) => (false, Some(format!("present but unreadable: {error}"))),
        },
        Err(_) => (false, None),
    };
    Ok(fcm_decoder::DecoderStatus {
        installed, version: fcm_decoder::FFMPEG_VERSION.to_string(), path: installed.then(|| path.to_string_lossy().to_string()),
        licence: fcm_decoder::LICENCE_LABEL.to_string(), licence_url: fcm_decoder::licence_url(), download_bytes: fcm_decoder::FFMPEG_BYTES, rejected_reason,
    })
}

fn download_verified(app: &tauri::AppHandle, url: &str, destination: &Path, expected_sha256: &str, expected_bytes: Option<u64>, report: bool) -> Result<(), String> {
    if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?; }
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_secs(300)).build();
    let response = agent.get(url).call().map_err(|error| format!("Download failed: {}", describe_http_error(error)))?;
    let total = response.header("Content-Length").and_then(|value| value.parse::<u64>().ok()).or(expected_bytes).unwrap_or(0);
    let partial = destination.with_extension("part");
    let mut file = File::create(&partial).map_err(|error| format!("Could not create {}: {error}", partial.display()))?;
    let mut reader = response.into_reader();
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    let mut done = 0_u64;
    let mut last_report = 0_u64;
    loop {
        let count = reader.read(&mut buffer).map_err(|error| format!("Download interrupted after {} MB: {error}", done / 1_048_576))?;
        if count == 0 { break; }
        file.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
        hasher.update(&buffer[..count]);
        done += count as u64;
        if report && done - last_report >= 4 * 1_048_576 { last_report = done; let _ = app.emit("decoder-progress", DecoderProgress { bytes_done: done, total_bytes: total }); }
    }
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if digest != expected_sha256 {
        let _ = fs::remove_file(&partial);
        return Err(format!("The downloaded file's hash {}… does not match the pinned build. It was discarded; nothing was installed.", &digest[..12]));
    }
    fs::rename(&partial, destination).map_err(|error| format!("Could not commit {}: {error}", destination.display()))?;
    if report { let _ = app.emit("decoder-progress", DecoderProgress { bytes_done: done, total_bytes: done }); }
    Ok(())
}

/// Download the pinned FFmpeg build (and its licence) into the app's local data folder, verifying both hashes.
#[tauri::command(async)]
fn install_decoder(app: tauri::AppHandle) -> Result<fcm_decoder::DecoderStatus, String> {
    let data = app_local_data(&app)?;
    download_verified(&app, &fcm_decoder::licence_url(), &fcm_decoder::licence_path(&data), fcm_decoder::LICENSE_SHA256, None, false)?;
    download_verified(&app, &fcm_decoder::ffmpeg_url(), &fcm_decoder::ffmpeg_path(&data), fcm_decoder::FFMPEG_SHA256, Some(fcm_decoder::FFMPEG_BYTES), true)?;
    decoder_status(app)
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String], timeout: Duration) -> Result<(bool, String), String> {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| format!("The decoder could not be started: {error}"))?;
    let mut stderr = child.stderr.take().ok_or("decoder stderr unavailable")?;
    let started = Instant::now();
    let reader = std::thread::spawn(move || { let mut text = String::new(); let _ = stderr.read_to_string(&mut text); text });
    loop {
        match child.try_wait() {
            Ok(Some(status)) => { let text = reader.join().unwrap_or_default(); return Ok((status.success(), text)); }
            Ok(None) if started.elapsed() > timeout => { let _ = child.kill(); return Err(format!("The decoder took longer than {} s and was stopped.", timeout.as_secs())); }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Key frames spread across a video file, as small JPEGs with their offset from the first one. `key_frames`
/// comes from an `-r2` extraction; an ordinary file passes 0 and its probed duration instead.
#[tauri::command(async)]
fn render_filmstrip(app: tauri::AppHandle, clip_path: String, key_frames: u32, count: Option<u32>, duration_seconds: Option<f64>) -> Result<Filmstrip, String> {
    let ffmpeg = verified_ffmpeg(&app)?;
    let count = count.unwrap_or(12).clamp(1, 40);
    let work = std::env::temp_dir().join(format!("fcm-filmstrip-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let pattern = work.join("t-%02d.jpg").to_string_lossy().to_string();
    let plan = fcm_decoder::filmstrip_plan(key_frames, duration_seconds, count);
    let (ok, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::filmstrip_args(&clip_path, &pattern, plan, count), Duration::from_secs(180))?;
    let times = fcm_decoder::parse_showinfo_times(&stderr);
    let mut names: Vec<PathBuf> = fs::read_dir(&work).map_err(|error| error.to_string())?.filter_map(|entry| entry.ok().map(|entry| entry.path())).filter(|path| path.extension().map(|ext| ext == "jpg").unwrap_or(false)).collect();
    names.sort();
    if names.is_empty() {
        let _ = fs::remove_dir_all(&work);
        return Err(if ok { "The decoder produced no frames for this recording.".to_string() } else { format!("The decoder could not read this recording: {}", stderr.lines().last().unwrap_or("no detail").trim()) });
    }
    let frames = names.iter().enumerate().map(|(index, path)| {
        let bytes = fs::read(path).unwrap_or_default();
        FilmstripFrame { at_seconds: times.get(index).copied().unwrap_or(0.0), jpeg_base64: base64::engine::general_purpose::STANDARD.encode(bytes) }
    }).collect();
    let _ = fs::remove_dir_all(&work);
    Ok(Filmstrip { frames, key_frames_used: match plan { fcm_decoder::FilmstripPlan::Stride(stride) => stride, fcm_decoder::FilmstripPlan::Interval(_) => 0 } })
}

/// A 480p H.264 viewing copy under the app's local data folder (GPU encoder first, software fallback).
/// Never uploaded, never registered: the evidence is the extracted original.
#[tauri::command(async)]
fn render_preview(app: tauri::AppHandle, clip_path: String) -> Result<PreviewRendition, String> {
    let ffmpeg = verified_ffmpeg(&app)?;
    let stem = Path::new(&clip_path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".to_string());
    let previews = app_local_data(&app)?.join("previews");
    fs::create_dir_all(&previews).map_err(|error| error.to_string())?;
    let output = previews.join(format!("{stem}.preview.mp4"));
    if let Ok(metadata) = fs::metadata(&output) {
        // A previous run's viewing copy; which encoder produced it is not recorded, so say so.
        if metadata.len() > 0 { return Ok(PreviewRendition { path: output.to_string_lossy().to_string(), bytes: metadata.len(), encoder: None, seconds: 0.0, cached: true }); }
    }
    let started = Instant::now();
    let mut encoder = fcm_decoder::PreviewEncoder::Nvenc;
    let (ok, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::preview_args(&clip_path, &output.to_string_lossy(), encoder), Duration::from_secs(600))?;
    let (ok, stderr) = if !ok && fcm_decoder::encoder_unavailable(&stderr) {
        encoder = fcm_decoder::PreviewEncoder::Software;
        run_ffmpeg(&ffmpeg, &fcm_decoder::preview_args(&clip_path, &output.to_string_lossy(), encoder), Duration::from_secs(900))?
    } else { (ok, stderr) };
    if !ok {
        let _ = fs::remove_file(&output);
        return Err(format!("The preview could not be rendered: {}", stderr.lines().last().unwrap_or("no detail").trim()));
    }
    let bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(PreviewRendition { path: output.to_string_lossy().to_string(), bytes, encoder: Some(encoder), seconds: started.elapsed().as_secs_f64(), cached: false })
}

/// Previews are derived viewing copies; clearing them frees disk without touching evidence.
#[tauri::command(async)]
fn clear_previews(app: tauri::AppHandle) -> Result<u64, String> {
    let previews = app_local_data(&app)?.join("previews");
    let mut freed = 0_u64;
    if let Ok(entries) = fs::read_dir(&previews) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|ext| ext == "mp4").unwrap_or(false) { freed += entry.metadata().map(|m| m.len()).unwrap_or(0); let _ = fs::remove_file(entry.path()); }
        }
    }
    if let Ok(entries) = fs::read_dir(previews.join("thumbs")) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|ext| ext == "jpg").unwrap_or(false) { freed += entry.metadata().map(|m| m.len()).unwrap_or(0); let _ = fs::remove_file(entry.path()); }
        }
    }
    Ok(freed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thumbnail { jpeg_base64: String, cached: bool }

/// One small JPEG of a file's first key frame for the list, kept under the app's previews folder against the
/// file's path, size and modified time so a changed file is decoded again. A viewing aid only, never sent.
#[tauri::command(async)]
fn render_thumbnail(app: tauri::AppHandle, path: String) -> Result<Thumbnail, String> {
    let ffmpeg = verified_ffmpeg(&app)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("The file could not be read: {error}"))?;
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes()); hasher.update(metadata.len().to_le_bytes()); hasher.update(modified.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let thumbs = app_local_data(&app)?.join("previews").join("thumbs");
    fs::create_dir_all(&thumbs).map_err(|error| error.to_string())?;
    let output = thumbs.join(format!("{}.jpg", &digest[..32]));
    if let Ok(bytes) = fs::read(&output) {
        if !bytes.is_empty() { return Ok(Thumbnail { jpeg_base64: base64::engine::general_purpose::STANDARD.encode(bytes), cached: true }); }
    }
    let (ok, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::thumbnail_args(&path, &output.to_string_lossy()), Duration::from_secs(45))?;
    let bytes = fs::read(&output).unwrap_or_default();
    if bytes.is_empty() {
        let _ = fs::remove_file(&output);
        return Err(if ok { "The decoder produced no frame for this file.".to_string() } else { format!("The decoder could not read this file: {}", stderr.lines().last().unwrap_or("no detail").trim()) });
    }
    Ok(Thumbnail { jpeg_base64: base64::engine::general_purpose::STANDARD.encode(bytes), cached: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mp4Export { path: String, bytes: u64, mode: Option<fcm_decoder::Mp4Mode>, seconds: f64, existing: bool }

/// A playable full-resolution `.mp4` of an extracted recording, next to wherever the operator asked. H.264 is
/// copied frame for frame; anything else is re-encoded (GPU, then software) so it plays on a stock Windows
/// install. A derived copy for the operator's own use: the hashed `.dav` remains the evidence.
#[tauri::command(async)]
fn export_mp4(app: tauri::AppHandle, clip_path: String, output_directory: String, codec: String) -> Result<Mp4Export, String> {
    let ffmpeg = verified_ffmpeg(&app)?;
    let stem = Path::new(&clip_path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".to_string());
    fs::create_dir_all(&output_directory).map_err(|error| format!("Could not create {output_directory}: {error}"))?;
    let output = Path::new(&output_directory).join(format!("{stem}.mp4"));
    if let Ok(metadata) = fs::metadata(&output) {
        if metadata.len() > 0 { return Ok(Mp4Export { path: output.to_string_lossy().to_string(), bytes: metadata.len(), mode: None, seconds: 0.0, existing: true }); }
    }
    let started = Instant::now();
    let out = output.to_string_lossy().to_string();
    let mut mode = fcm_decoder::mp4_mode_for(&codec);
    let (mut ok, mut stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::mp4_args(&clip_path, &out, mode), Duration::from_secs(1800))?;
    if !ok && mode == fcm_decoder::Mp4Mode::StreamCopy {
        mode = fcm_decoder::Mp4Mode::H264(fcm_decoder::PreviewEncoder::Nvenc);
        (ok, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::mp4_args(&clip_path, &out, mode), Duration::from_secs(1800))?;
    }
    if !ok && fcm_decoder::encoder_unavailable(&stderr) {
        mode = fcm_decoder::Mp4Mode::H264(fcm_decoder::PreviewEncoder::Software);
        (ok, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::mp4_args(&clip_path, &out, mode), Duration::from_secs(3600))?;
    }
    if !ok {
        let _ = fs::remove_file(&output);
        return Err(format!("The MP4 could not be written: {}", stderr.lines().last().unwrap_or("no detail").trim()));
    }
    let bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(Mp4Export { path: out, bytes, mode: Some(mode), seconds: started.elapsed().as_secs_f64(), existing: false })
}

// ---------------------------------------------------------------------------------------------
// Video files already on this computer (or in a synced cloud folder): a second source besides the card
// ---------------------------------------------------------------------------------------------

const VIDEO_EXTENSIONS: [&str; 15] = ["mp4", "mov", "mkv", "avi", "m4v", "ts", "h264", "h265", "hevc", "264", "265", "dav", "asf", "wmv", "webm"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalVideoFile { path: String, file_name: String, extension: String, bytes: u64, modified_epoch_ms: u64, content: &'static str, container: Option<&'static str> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoFolder { directory: String, files: Vec<LocalVideoFile>, subfolders: u32, other_files: u32 }

#[cfg(windows)]
fn is_cloud_placeholder(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    metadata.file_attributes() & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0
}
#[cfg(not(windows))]
fn is_cloud_placeholder(_metadata: &fs::Metadata) -> bool { false }

/// What a file holds, from its name and 4 KiB at four offsets — never the decoder, never a full read.
/// `offline` (a cloud placeholder) is not opened: reading it would make the sync client fetch the whole file.
/// `unwritten` is a slot the recorder pre-allocated and never recorded into; `blank` is filler bytes throughout;
/// `video` names the container found; `unrecognised` is data with no known signature, listed and left to the
/// decoder.
fn sniff_video_content(path: &Path, file_name: &str, metadata: &fs::Metadata) -> (&'static str, Option<&'static str>) {
    const SAMPLE: usize = 4096;
    if is_cloud_placeholder(metadata) { return ("offline", None); }
    if fcm_decoder::is_unwritten_slot_name(file_name) { return ("unwritten", None); }
    let len = metadata.len();
    let Ok(mut file) = File::open(path) else { return ("unrecognised", None); };
    let mut read_at = |offset: u64| -> Vec<u8> {
        let mut buffer = vec![0_u8; SAMPLE.min(len.saturating_sub(offset) as usize)];
        if buffer.is_empty() || file.seek(SeekFrom::Start(offset)).is_err() { return Vec::new(); }
        let mut done = 0;
        while done < buffer.len() { match file.read(&mut buffer[done..]) { Ok(0) | Err(_) => break, Ok(count) => done += count } }
        buffer.truncate(done);
        buffer
    };
    let head = read_at(0);
    if let Some(container) = fcm_decoder::container_signature(&head) { return ("video", Some(container)); }
    let body: Vec<Vec<u8>> = if len > (SAMPLE as u64) * 4 { [len / 4, len / 2, len / 4 * 3].into_iter().map(&mut read_at).collect() } else { Vec::new() };
    let samples: Vec<&[u8]> = std::iter::once(head.as_slice()).chain(body.iter().map(Vec::as_slice)).collect();
    if fcm_decoder::is_blank(&samples) { return ("blank", None); }
    ("unrecognised", None)
}

/// A file as the list shows it, or `None` when it is not a non-empty video file by extension.
fn describe_video_file(path: &Path, metadata: &fs::Metadata) -> Option<LocalVideoFile> {
    let extension = path.extension().map(|ext| ext.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&extension.as_str()) || metadata.len() == 0 { return None; }
    let modified_epoch_ms = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (content, container) = sniff_video_content(path, &file_name, metadata);
    Some(LocalVideoFile { path: path.to_string_lossy().to_string(), file_name, extension, bytes: metadata.len(), modified_epoch_ms, content, container })
}

/// The video files directly inside a folder (not its subfolders), by name. Each is opened only for the
/// content sniff (a few kilobytes); nothing is decoded or hashed yet.
#[tauri::command(async)]
fn list_video_files(directory: String) -> Result<VideoFolder, String> {
    let entries = fs::read_dir(&directory).map_err(|error| format!("The folder could not be read: {error}"))?;
    let mut files = Vec::new();
    let (mut subfolders, mut other_files) = (0_u32, 0_u32);
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue; };
        if metadata.is_dir() { subfolders += 1; continue; }
        match describe_video_file(&entry.path(), &metadata) { Some(file) => files.push(file), None => other_files += 1 }
    }
    files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(VideoFolder { directory, files, subfolders, other_files })
}

/// Files the operator picked one by one. Non-video or empty picks are counted, not listed, so the operator
/// can see that a pick was set aside rather than wonder where it went.
#[tauri::command(async)]
fn describe_video_files(paths: Vec<String>) -> Result<VideoFolder, String> {
    let mut files = Vec::new();
    let mut other_files = 0_u32;
    for path in &paths {
        let path = Path::new(path);
        let metadata = fs::metadata(path).map_err(|error| format!("{} could not be read: {error}", path.display()))?;
        if metadata.is_dir() { other_files += 1; continue; }
        match describe_video_file(path, &metadata) { Some(file) => files.push(file), None => other_files += 1 }
    }
    files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    let parent_of = |path: &str| Path::new(path).parent().map(|p| p.to_string_lossy().to_string());
    let directory = files.first().and_then(|file| parent_of(&file.path)).or_else(|| paths.first().and_then(|p| parent_of(p))).unwrap_or_default();
    Ok(VideoFolder { directory, files, subfolders: 0, other_files })
}

/// The JPEGs of a picture-stream extraction, base64, so the review can show the pictures themselves.
#[tauri::command(async)]
fn read_pictures(paths: Vec<String>) -> Result<Vec<String>, String> {
    const MAX_FILES: usize = 40;
    const MAX_BYTES: u64 = 4 << 20;
    paths.iter().take(MAX_FILES).map(|path| {
        let metadata = fs::metadata(path).map_err(|error| format!("{path}: {error}"))?;
        if metadata.len() > MAX_BYTES { return Err(format!("{path} is {} MB, larger than a picture-stream JPEG; not shown.", metadata.len() >> 20)); }
        let bytes = fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDigest { sha256: String, bytes: u64 }

/// SHA-256 of a file on disk, streamed; taken before sending so FCM can verify what arrived.
#[tauri::command(async)]
fn hash_local_file(path: String) -> Result<FileDigest, String> {
    let mut file = File::open(&path).map_err(|error| format!("The file could not be opened: {error}"))?;
    let bytes = file.metadata().map_err(|error| error.to_string())?.len();
    let sha256 = fcm_decoder::sha256_of(&mut file).map_err(|error| format!("The file could not be read: {error}"))?;
    Ok(FileDigest { sha256, bytes })
}

/// Duration, container creation time, codec and size of a video file, from the decoder's banner.
#[tauri::command(async)]
fn probe_video_file(app: tauri::AppHandle, path: String) -> Result<fcm_decoder::MediaProbe, String> {
    let ffmpeg = verified_ffmpeg(&app)?;
    // ffmpeg exits non-zero here by design (no output was asked for); the banner on stderr is the result.
    let (_, stderr) = run_ffmpeg(&ffmpeg, &fcm_decoder::probe_args(&path), Duration::from_secs(60))?;
    let probe = fcm_decoder::parse_media_probe(&stderr);
    if probe.duration_seconds.is_none() && probe.codec.is_none() {
        return Err(format!("The decoder could not read this file: {}", stderr.lines().find(|line| line.contains("Invalid") || line.contains("No such") || line.contains("Permission")).or_else(|| stderr.lines().last()).unwrap_or("no detail").trim()));
    }
    Ok(probe)
}

// ---------------------------------------------------------------------------------------------
// Review state: the operator's marks and place choices for a card or folder, kept between sessions
// ---------------------------------------------------------------------------------------------

fn review_state_path(app: &tauri::AppHandle, scope: &str) -> Result<PathBuf, String> {
    // The scope names the source (card layout or folder path); hashing it keeps the filename safe and short.
    let digest = format!("{:x}", Sha256::digest(scope.as_bytes()));
    Ok(app_local_data(app)?.join("review-state").join(format!("{digest}.json")))
}

/// The saved review state for a source, or null when none has been kept yet.
#[tauri::command(async)]
fn load_review_state(app: tauri::AppHandle, scope: String) -> Result<Option<serde_json::Value>, String> {
    let path = review_state_path(&app, &scope)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| format!("The saved review state is unreadable and was ignored: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("The saved review state could not be read: {error}")),
    }
}

/// Write the review state atomically (whole file replaced, never half-written).
#[tauri::command(async)]
fn save_review_state(app: tauri::AppHandle, scope: String, state: serde_json::Value) -> Result<(), String> {
    let path = review_state_path(&app, &scope)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?; }
    let partial = path.with_extension("json.part");
    fs::write(&partial, serde_json::to_vec(&state).map_err(|error| error.to_string())?).map_err(|error| format!("Could not write {}: {error}", partial.display()))?;
    fs::rename(&partial, &path).map_err(|error| format!("Could not commit {}: {error}", path.display()))
}

// ---------------------------------------------------------------------------------------------
// Disk on this computer: what the app has written, and removal that cannot reach outside its own folders
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskEntry { path: String, name: String, bytes: u64, kind: String, modified_epoch_ms: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskReport { directory: String, entries: Vec<DiskEntry>, total_bytes: u64, previews_directory: String, previews_bytes: u64, previews_count: u32, tools_bytes: u64, acquisitions_root: String, other_cards_bytes: u64, other_cards_folders: u32 }

fn dir_size(path: &Path) -> u64 {
    let mut total = 0_u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue; };
            total += if meta.is_dir() { dir_size(&entry.path()) } else { meta.len() };
        }
    }
    total
}

fn disk_kind(path: &Path, is_dir: bool) -> &'static str {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.ends_with(".part") || name.ends_with(".part-dir") { return "partial"; }
    if is_dir { return "pictures"; }
    match path.extension().map(|ext| ext.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("dav") | Some("h264") | Some("h265") | Some("dhfs") => "video",
        Some("mp4") => "mp4",
        Some("img") => "image",
        _ => "other",
    }
}

/// Everything in one working folder by kind and size, plus the app's previews and tools, plus how much other
/// cards' working folders hold beside it. Nothing is opened beyond metadata; nothing is changed.
#[tauri::command(async)]
fn disk_report(app: tauri::AppHandle, directory: String) -> Result<DiskReport, String> {
    let dir = Path::new(&directory);
    let mut entries = Vec::new();
    let mut total = 0_u64;
    if let Ok(read) = fs::read_dir(dir) {
        for entry in read.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue; };
            if meta.file_type().is_symlink() { continue; }
            let bytes = if meta.is_dir() { dir_size(&path) } else { meta.len() };
            total += bytes;
            entries.push(DiskEntry {
                path: path.to_string_lossy().to_string(), name: entry.file_name().to_string_lossy().to_string(), bytes, kind: disk_kind(&path, meta.is_dir()).to_string(),
                modified_epoch_ms: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
            });
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let data = app_local_data(&app)?;
    let previews = data.join("previews");
    let (mut previews_bytes, mut previews_count) = (0_u64, 0_u32);
    if let Ok(read) = fs::read_dir(&previews) {
        for entry in read.flatten() { if let Ok(meta) = entry.metadata() { if meta.is_file() { previews_bytes += meta.len(); previews_count += 1; } } }
    }
    let acquisitions_root = dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| dir.to_path_buf());
    let (mut other_bytes, mut other_folders) = (0_u64, 0_u32);
    if let Ok(read) = fs::read_dir(&acquisitions_root) {
        for entry in read.flatten() {
            let path = entry.path();
            if path == dir { continue; }
            if let Ok(meta) = fs::symlink_metadata(&path) { if meta.is_dir() { other_folders += 1; other_bytes += dir_size(&path); } }
        }
    }
    Ok(DiskReport {
        directory, entries, total_bytes: total, previews_directory: previews.to_string_lossy().to_string(), previews_bytes, previews_count, tools_bytes: dir_size(&data.join("tools")),
        acquisitions_root: acquisitions_root.to_string_lossy().to_string(), other_cards_bytes: other_bytes, other_cards_folders: other_folders,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovalFailure { path: String, error: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovalReport { removed: u32, freed_bytes: u64, failures: Vec<RemovalFailure> }

/// Remove the named files or picture folders, and only those: each must resolve to a path inside one of `roots`
/// (the working folder or the previews folder), must not be a symlink, and is removed one by one with the
/// outcome reported per path. The interface decides *what* is safe to remove; this decides *where* it may reach.
#[tauri::command(async)]
fn remove_local_files(paths: Vec<String>, roots: Vec<String>) -> Result<RemovalReport, String> {
    let roots: Vec<PathBuf> = roots.iter().filter_map(|root| fs::canonicalize(root).ok()).collect();
    if roots.is_empty() { return Err("No removal root could be resolved; nothing was removed.".to_string()); }
    let mut report = RemovalReport { removed: 0, freed_bytes: 0, failures: Vec::new() };
    for raw in paths {
        let path = Path::new(&raw);
        let outcome = (|| -> Result<u64, String> {
            let meta = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if meta.file_type().is_symlink() { return Err("is a link, not a file; left alone".to_string()); }
            let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
            if !roots.iter().any(|root| canonical.starts_with(root) && canonical != *root) { return Err("is outside the folders this app manages; left alone".to_string()); }
            let bytes = if meta.is_dir() { dir_size(&canonical) } else { meta.len() };
            if meta.is_dir() { fs::remove_dir_all(&canonical).map_err(|error| error.to_string())?; } else { fs::remove_file(&canonical).map_err(|error| error.to_string())?; }
            Ok(bytes)
        })();
        match outcome {
            Ok(bytes) => { report.removed += 1; report.freed_bytes += bytes; }
            Err(error) => report.failures.push(RemovalFailure { path: raw, error }),
        }
    }
    Ok(report)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).invoke_handler(tauri::generate_handler![discover_read_only_devices, probe_device, acquire_read_only_device_image, cancel_acquisition, inspect_acquisition_image, read_dhfs_catalog, extract_dhfs_recording, default_clip_directory, upload_clip_resumable, cancel_upload, decoder_status, install_decoder, render_filmstrip, render_preview, clear_previews, render_thumbnail, export_mp4, list_video_files, describe_video_files, hash_local_file, probe_video_file, read_pictures, load_review_state, save_review_state, disk_report, remove_local_files]).run(tauri::generate_context!()).expect("error while running FCM Desktop V2");
}
