use fcm_dhfs::{AlignedFileSource, Catalog, ExtractedClip, LocationMethod, Volume, DEVICE_READ_ALIGNMENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::Path, sync::atomic::{AtomicBool, Ordering}, time::Instant};
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
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DISCOVERY_SCRIPT]).output().map_err(|e| format!("PowerShell could not be started to list disks: {e}"))?;
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
                    return Err(format!("Not enough free space for the image: the card is {:.1} GB but only {:.1} GB is free at {}. Choose another drive.", size_bytes as f64 / 1e9, free as f64 / 1e9, destination.parent().map(|p| p.display().to_string()).unwrap_or_default()));
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
#[tauri::command(async)]
fn extract_dhfs_recording(source: DhfsSourceSpec, partition_index: u32, descriptor: u32, destination_directory: String) -> Result<ExtractedClip, String> {
    let mut block_source = open_source(&source)?;
    let catalog = fcm_dhfs::catalog(&mut block_source).map_err(|error| error.to_string())?;
    let recording = catalog.recordings.iter()
        .find(|recording| recording.partition_index == partition_index && recording.descriptor == descriptor)
        .ok_or("That recording is no longer present on the source. Re-read the catalog before extracting.")?;
    fcm_dhfs::extract_recording_to_directory(&mut block_source, &catalog.volume, recording, Path::new(&destination_directory), source.label())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).invoke_handler(tauri::generate_handler![discover_read_only_devices, probe_device, acquire_read_only_device_image, cancel_acquisition, inspect_acquisition_image, read_dhfs_catalog, extract_dhfs_recording]).run(tauri::generate_context!()).expect("error while running FCM Desktop V2");
}
