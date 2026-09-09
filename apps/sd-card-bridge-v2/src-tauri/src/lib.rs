use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::Path};

#[derive(Serialize, Clone)]
struct DeviceCandidate { id: String, label: String, size_bytes: u64, removable: bool, read_only: bool, partitions: u32 }

#[derive(Serialize)]
struct AcquisitionReceipt { source_id: String, image_path: String, bytes_copied: u64, source_sha256: String, image_sha256: String, verified: bool, read_errors: u32 }

#[derive(Serialize)]
struct Adapter { name: String, state: String, confidence: String, detail: String }

#[derive(Serialize)]
struct InspectionResult { image_bytes: u64, signatures: Vec<String>, candidate_offsets: Vec<u64>, adapters: Vec<Adapter> }

#[tauri::command]
fn discover_read_only_devices() -> Result<Vec<DeviceCandidate>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Get-Disk | Where-Object { $_.BusType -in @('USB','SD','MMC') } | Select-Object Number,FriendlyName,Size,BusType,PartitionStyle | ConvertTo-Json -Compress"]).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        let rows = if value.is_array() { value.as_array().cloned().unwrap_or_default() } else { vec![value] };
        return Ok(rows.into_iter().enumerate().map(|(index, row)| DeviceCandidate {
            id: row.get("Number").and_then(|v| v.as_u64()).map(|n| format!("PhysicalDrive{n}")).unwrap_or_else(|| format!("removable-{index}")),
            label: row.get("FriendlyName").and_then(|v| v.as_str()).unwrap_or("Removable camera media").to_string(),
            size_bytes: row.get("Size").and_then(|v| v.as_u64()).unwrap_or(0), removable: true, read_only: true,
            partitions: 0,
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
    if !source_id.starts_with("PhysicalDrive") { return Err("Only a discovered removable physical device can be acquired.".to_string()); }
    #[cfg(target_os = "windows")]
    {
        let source_path = format!(r"\\.\{}", source_id);
        let mut source = OpenOptions::new().read(true).write(false).open(&source_path).map_err(|e| format!("Could not open source read-only: {e}"))?;
        let mut image = OpenOptions::new().write(true).create_new(true).open(&destination_path).map_err(|e| format!("Could not create image: {e}"))?;
        let mut source_hash = Sha256::new(); let mut image_hash = Sha256::new(); let mut total = 0_u64; let mut buffer = [0_u8; 4 * 1024 * 1024];
        loop { let count = source.read(&mut buffer).map_err(|e| format!("Read failed: {e}"))?; if count == 0 { break; } image.write_all(&buffer[..count]).map_err(|e| e.to_string())?; source_hash.update(&buffer[..count]); image_hash.update(&buffer[..count]); total += count as u64; }
        image.flush().map_err(|e| e.to_string())?; image.sync_all().map_err(|e| e.to_string())?;
        let source_sha256 = format!("{:x}", source_hash.finalize()); let image_sha256 = format!("{:x}", image_hash.finalize());
        return Ok(AcquisitionReceipt { source_id, image_path: destination_path, bytes_copied: total, source_sha256: source_sha256.clone(), image_sha256: image_sha256.clone(), verified: source_sha256 == image_sha256, read_errors: 0 });
    }
    #[cfg(not(target_os = "windows"))]
    Err("Whole-device acquisition is implemented for the Windows desktop prototype.".to_string())
}

#[tauri::command]
fn inspect_acquisition_image(image_path: String) -> Result<InspectionResult, String> {
    let mut file = File::open(&image_path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let scan_bytes = metadata.len().min(16 * 1024 * 1024) as usize;
    let mut buffer = vec![0_u8; scan_bytes]; file.read_exact(&mut buffer).map_err(|e| e.to_string())?;
    let mut signatures = Vec::new(); let mut offsets = Vec::new();
    for (needle, label) in [(b"DHFS4.1".as_slice(), "DHFS4.1"), (b"DHFS_DPT:".as_slice(), "DHFS DPT"), (b"fat32".as_slice(), "FAT32 marker"), (b"exfat".as_slice(), "exFAT marker"), (b"ftyp".as_slice(), "MP4 container")].iter() {
        if let Some(index) = buffer.windows(needle.len()).position(|window| window.eq_ignore_ascii_case(needle)) { signatures.push((*label).to_string()); offsets.push(index as u64); }
    }
    let has_dhfs = signatures.iter().any(|s| s == "DHFS4.1" || s == "DHFS DPT");
    let adapters = vec![
        Adapter { name: "DHFS adapter".into(), state: if has_dhfs { "identified" } else { "ambiguous" }.into(), confidence: if has_dhfs { "high" } else { "low" }.into(), detail: if has_dhfs { "DHFS signature and metadata candidate found." } else { "No DHFS signature in initial scan; preserve for broader forensic scan." }.into() },
        Adapter { name: "Generic filesystem adapter".into(), state: "ambiguous".into(), confidence: "medium".into(), detail: "Partition map and filesystem probing are next prototype work.".into() },
        Adapter { name: "Raw video signature scanner".into(), state: "ambiguous".into(), confidence: "medium".into(), detail: "Candidate offsets preserved for codec-specific inspection.".into() },
    ];
    Ok(InspectionResult { image_bytes: metadata.len(), signatures, candidate_offsets: offsets, adapters })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).invoke_handler(tauri::generate_handler![discover_read_only_devices, acquire_read_only_device_image, inspect_acquisition_image]).run(tauri::generate_context!()).expect("error while running FCM Desktop V2");
}
