use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct IndexRecord {
    record_number: i64,
    channel: i64,
    start_time_utc: Option<String>,
    end_time_utc: Option<String>,
    length_bytes: i64,
    cluster_number: i64,
    index_in_cluster: i64,
    event_names: Vec<String>,
}

#[derive(Serialize)]
struct IndexReport {
    database_path: String,
    database_sha256: String,
    record_count: usize,
    valid_timestamped_record_count: usize,
    event_definitions: Vec<String>,
    records: Vec<IndexRecord>,
}

#[derive(Serialize)]
struct MountedFile {
    relative_path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
struct MountedFolderReport {
    folder_path: String,
    file_count: usize,
    total_bytes: u64,
    truncated: bool,
    files: Vec<MountedFile>,
}

#[derive(Deserialize, Serialize)]
struct DiskPartition {
        partition_number: u32,
        drive_letter: Option<String>,
        size_bytes: u64,
        filesystem: Option<String>,
        label: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RemovableDisk {
        disk_number: u32,
        friendly_name: String,
        bus_type: String,
        size_bytes: u64,
        operational_status: String,
        partitions: Vec<DiskPartition>,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn unix_timestamp(timestamp: i64) -> Option<String> {
    if timestamp <= 0 { return None; }
    DateTime::<Utc>::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn detect_removable_disks() -> Result<Vec<RemovableDisk>, String> {
        use std::process::Command;

        let script = r#"
            $disks = @(Get-Disk | Where-Object { $_.BusType -in @('USB', 'SD', 'MMC') } | ForEach-Object {
                $disk = $_
                $partitions = @(Get-Partition -DiskNumber $disk.Number | ForEach-Object {
                    $partition = $_
                    $volume = $partition | Get-Volume -ErrorAction SilentlyContinue
                    [pscustomobject]@{
                        partition_number = [uint32]$partition.PartitionNumber
                        drive_letter = if ($volume -and $volume.DriveLetter) { [string]$volume.DriveLetter } else { $null }
                        size_bytes = [uint64]$partition.Size
                        filesystem = if ($volume -and $volume.FileSystem) { [string]$volume.FileSystem } else { $null }
                        label = if ($volume -and $volume.FileSystemLabel) { [string]$volume.FileSystemLabel } else { $null }
                    }
                })
                [pscustomobject]@{
                    disk_number = [uint32]$disk.Number
                    friendly_name = [string]$disk.FriendlyName
                    bus_type = [string]$disk.BusType
                    size_bytes = [uint64]$disk.Size
                    operational_status = [string]$disk.OperationalStatus
                    partitions = $partitions
                }
            })
            ConvertTo-Json -InputObject @($disks) -Depth 5 -Compress
        "#;
        let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .map_err(|error| format!("Could not query Windows disk inventory: {error}"))?;
        if !output.status.success() {
                return Err(format!("Windows disk inventory failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let body = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        if body.trim().is_empty() {
                return Ok(Vec::new());
        }
        serde_json::from_str(&body).map_err(|error| format!("Could not parse Windows disk inventory: {error}"))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn detect_removable_disks() -> Result<Vec<RemovableDisk>, String> {
        Err("Removable disk discovery is available in the Windows FCM Desktop application.".to_string())
}

#[tauri::command]
fn inspect_mounted_folder(folder_path: String) -> Result<MountedFolderReport, String> {
    const MAX_FILES: usize = 5_000;
    let root = PathBuf::from(&folder_path);
    if !root.is_dir() {
        return Err("Select a mounted SD-card folder or drive root.".to_string());
    }
    let mut files = Vec::new();
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;
    let mut stack = vec![root.clone()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| format!("Could not read {directory:?}: {error}"))? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            file_count = file_count.saturating_add(1);
            total_bytes = total_bytes.saturating_add(metadata.len());
            if files.len() < MAX_FILES {
                let relative_path = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                files.push(MountedFile { relative_path, size_bytes: metadata.len() });
            }
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(MountedFolderReport { folder_path, file_count, total_bytes, truncated: file_count > MAX_FILES, files })
}

#[tauri::command]
fn inspect_sd_index(database_path: String) -> Result<IndexReport, String> {
    let path = Path::new(&database_path);
    if path.file_name().and_then(|name| name.to_str()) != Some("SDFileInfo.db") {
        return Err("Select the SDFileInfo.db index from a copied SD-card folder.".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|error| format!("Could not open the index read-only: {error}"))?;

    let event_definitions = connection.prepare("SELECT COALESCE(ED_Name, '') FROM EvtDef ORDER BY ED_Index")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    let mut statement = connection.prepare(
        "SELECT f.FI_RecNo, f.FI_Channel, f.FI_StartTimeRealUTC, f.FI_EndTimeRealUTC,
                f.FI_Length, f.FI_ClusterNo, f.FI_IndexInCluster,
                COALESCE(group_concat(d.ED_Name, '|'), '')
           FROM File f
      LEFT JOIN Event e ON e.ET_FI_RecNo = f.FI_RecNo
      LEFT JOIN EvtDef d ON d.ED_Index = e.ET_ED_Index
       GROUP BY f.FI_RecNo
       ORDER BY f.FI_StartTimeRealUTC"
    ).map_err(|error| format!("The index schema is not recognised: {error}"))?;

    let records = statement.query_map([], |row| {
        let events: String = row.get(7)?;
        Ok(IndexRecord {
            record_number: row.get(0)?, channel: row.get(1)?,
            start_time_utc: unix_timestamp(row.get(2)?), end_time_utc: unix_timestamp(row.get(3)?),
            length_bytes: row.get(4)?, cluster_number: row.get(5)?, index_in_cluster: row.get(6)?,
            event_names: events.split('|').filter(|name| !name.is_empty()).map(str::to_owned).collect(),
        })
    }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let valid_timestamped_record_count = records.iter().filter(|record| record.start_time_utc.is_some() && record.end_time_utc.is_some()).count();
    let database_sha256 = sha256_file(path)?;

    Ok(IndexReport { database_path, database_sha256, record_count: records.len(), valid_timestamped_record_count, event_definitions, records })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![detect_removable_disks, inspect_mounted_folder, inspect_sd_index])
        .run(tauri::generate_context!())
        .expect("error while running FCM SD Card Bridge");
}