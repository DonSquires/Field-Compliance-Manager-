use fcm_dhfs::{AlignedFileSource, Catalog, ExtractedClip, LocationMethod, Volume, DEVICE_READ_ALIGNMENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::Path};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeviceCandidate { id: String, label: String, size_bytes: u64, removable: bool, read_only: bool, partitions: u32, partition_style: String, bus_type: String }

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

fn open_source(spec: &DhfsSourceSpec) -> Result<AlignedFileSource, String> {
    match spec {
        DhfsSourceSpec::Image { path } => AlignedFileSource::open_image(Path::new(path)).map_err(|error| error.to_string()),
        DhfsSourceSpec::Device { id, size_bytes } => {
            if !is_physical_drive_id(id) { return Err("Only a discovered removable physical device can be read.".to_string()); }
            #[cfg(target_os = "windows")]
            {
                let device_path = format!(r"\\.\{id}");
                let file = OpenOptions::new().read(true).write(false).open(&device_path)
                    .map_err(|error| format!("Could not open {device_path} read-only: {error}"))?;
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

#[tauri::command]
fn discover_read_only_devices() -> Result<Vec<DeviceCandidate>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Get-Disk | Where-Object { $_.BusType -in @('USB','SD','MMC') } | Select-Object Number,FriendlyName,Size,BusType,PartitionStyle,NumberOfPartitions | ConvertTo-Json -Compress"]).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        if output.stdout.iter().all(|byte| byte.is_ascii_whitespace()) { return Ok(Vec::new()); }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        let rows = if value.is_array() { value.as_array().cloned().unwrap_or_default() } else { vec![value] };
        return Ok(rows.into_iter().enumerate().map(|(index, row)| DeviceCandidate {
            id: row.get("Number").and_then(|v| v.as_u64()).map(|n| format!("PhysicalDrive{n}")).unwrap_or_else(|| format!("removable-{index}")),
            label: row.get("FriendlyName").and_then(|v| v.as_str()).unwrap_or("Removable camera media").to_string(),
            size_bytes: row.get("Size").and_then(|v| v.as_u64()).unwrap_or(0), removable: true, read_only: true,
            partitions: row.get("NumberOfPartitions").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            partition_style: row.get("PartitionStyle").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
            bus_type: row.get("BusType").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
        }).collect());
    }
    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

fn hash_reader(mut reader: impl Read) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new(); let mut total = 0_u64; let mut buffer = [0_u8; 4 * 1024 * 1024];
    loop { let count = reader.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 { break; } total += count as u64; hasher.update(&buffer[..count]); }
    Ok((total, format!("{:x}", hasher.finalize())))
}

#[tauri::command]
fn acquire_read_only_device_image(source_id: String, destination_path: String) -> Result<AcquisitionReceipt, String> {
    if !is_physical_drive_id(&source_id) { return Err("Only a discovered removable physical device can be acquired.".to_string()); }
    #[cfg(target_os = "windows")]
    {
        let source_path = format!(r"\\.\{}", source_id);
        let mut source = OpenOptions::new().read(true).write(false).open(&source_path).map_err(|e| format!("Could not open source read-only: {e}"))?;
        let destination = Path::new(&destination_path);
        if destination.exists() { return Err("The destination already exists. Choose a new acquisition path; existing evidence will not be overwritten.".to_string()); }
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|e| format!("Could not create acquisition directory: {e}"))?; }
        let partial_path = destination.with_extension("img.part");
        let mut image = OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|e| format!("Could not create temporary image: {e}"))?;
        let mut source_hash = Sha256::new(); let mut image_hash = Sha256::new(); let mut total = 0_u64; let mut buffer = [0_u8; 4 * 1024 * 1024];
        loop { let count = source.read(&mut buffer).map_err(|e| format!("Read failed: {e}"))?; if count == 0 { break; } image.write_all(&buffer[..count]).map_err(|e| e.to_string())?; source_hash.update(&buffer[..count]); image_hash.update(&buffer[..count]); total += count as u64; }
        image.flush().map_err(|e| e.to_string())?; image.sync_all().map_err(|e| e.to_string())?;
        drop(image);
        fs::rename(&partial_path, destination).map_err(|e| format!("Could not commit verified image atomically: {e}"))?;
        let (verified_bytes, image_sha256) = hash_reader(File::open(destination).map_err(|e| format!("Could not reopen image for verification: {e}"))?)?;
        let source_sha256 = format!("{:x}", source_hash.finalize());
        let verified = verified_bytes == total && image_sha256 == format!("{:x}", image_hash.finalize());
        return Ok(AcquisitionReceipt { source_id, image_path: destination_path, bytes_copied: total, source_sha256, image_sha256, verified, read_errors: 0 });
    }
    #[cfg(not(target_os = "windows"))]
    Err("Whole-device acquisition is implemented for the Windows desktop prototype.".to_string())
}

fn location_label(volume: &Volume) -> String {
    match &volume.location.method {
        LocationMethod::DeviceStart => "raw device, no partition table".to_string(),
        LocationMethod::MbrPartition { index, type_code, .. } => format!("MBR partition {} type 0x{type_code:02x}, shown as RAW by Windows", index + 1),
        LocationMethod::GptPartition { index, .. } => format!("GPT partition {}", index + 1),
        LocationMethod::Scan => "found by sector scan".to_string(),
    }
}

#[tauri::command]
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
#[tauri::command]
fn read_dhfs_catalog(source: DhfsSourceSpec) -> Result<Catalog, String> {
    let mut block_source = open_source(&source)?;
    fcm_dhfs::catalog(&mut block_source).map_err(|error| error.to_string())
}

/// Copy one recording out of the volume into `destination_directory` (atomic, hashed, never overwrites).
#[tauri::command]
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
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).invoke_handler(tauri::generate_handler![discover_read_only_devices, acquire_read_only_device_image, inspect_acquisition_image, read_dhfs_catalog, extract_dhfs_recording]).run(tauri::generate_context!()).expect("error while running FCM Desktop V2");
}
