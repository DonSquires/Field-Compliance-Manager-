use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
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

#[derive(Clone, Deserialize, Serialize)]
struct DiskPartition {
        partition_number: u32,
        drive_letter: Option<String>,
        size_bytes: u64,
        offset_bytes: u64,
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

#[derive(Deserialize)]
struct PartitionCoordinates {
    offset_bytes: u64,
    size_bytes: u64,
}

#[derive(Serialize)]
struct PartitionProbe {
    disk_number: u32,
    partition_number: u32,
    offset_bytes: u64,
    bytes_read: usize,
    sha256: String,
    signature: String,
    format_hint: String,
}

#[derive(Serialize)]
struct ClusterSample {
    multiplier_bytes: u64,
    absolute_offset_bytes: u64,
    sha256: String,
    signature: String,
    format_hint: String,
}

#[derive(Serialize)]
struct ClusterMappingReport {
    disk_number: u32,
    partition_number: u32,
    cluster_number: i64,
    samples: Vec<ClusterSample>,
}

#[derive(Serialize)]
struct SdCardAnalysis {
    disks: Vec<RemovableDisk>,
    index_report: Option<IndexReport>,
    hidden_partition: Option<DiskPartition>,
    cluster_report: Option<ClusterMappingReport>,
    summary: String,
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

fn media_signature_hint(bytes: &[u8]) -> String {
    if bytes.windows(4).any(|window| window == [0, 0, 0, 1]) || bytes.windows(3).any(|window| window == [0, 0, 1]) {
        return "H.264/H.265 NAL start code detected".to_string();
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"AVI ") {
        return "AVI container header detected".to_string();
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return "MP4/MOV container header detected".to_string();
    }
    if bytes.starts_with(&[0x47]) || bytes.get(188) == Some(&0x47) {
        return "MPEG transport-stream packet marker detected".to_string();
    }
    if bytes.iter().all(|byte| *byte == 0) {
        return "All-zero sample".to_string();
    }
    "No standard media signature detected".to_string()
}

fn inspect_sd_index_at_path(path: &Path) -> Result<IndexReport, String> {
    let database_path = path.to_string_lossy().to_string();
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
    Ok(IndexReport { database_path, database_sha256: sha256_file(path)?, record_count: records.len(), valid_timestamped_record_count, event_definitions, records })
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
                        offset_bytes = [uint64]$partition.Offset
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

#[cfg(target_os = "windows")]
fn partition_coordinates(disk_number: u32, partition_number: u32) -> Result<PartitionCoordinates, String> {
    use std::process::Command;

    let script = format!(
        " $disk = Get-Disk -Number {disk_number} -ErrorAction Stop; if ($disk.BusType -notin @('USB', 'SD', 'MMC')) {{ throw 'Selected disk is not removable' }}; $partition = Get-Partition -DiskNumber {disk_number} -PartitionNumber {partition_number} -ErrorAction Stop; [pscustomobject]@{{ offset_bytes = [uint64]$partition.Offset; size_bytes = [uint64]$partition.Size }} | ConvertTo-Json -Compress "
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("Could not query the selected partition: {error}"))?;
    if !output.status.success() {
        return Err(format!("Partition query failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Could not parse selected partition: {error}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn probe_partition_header(disk_number: u32, partition_number: u32) -> Result<PartitionProbe, String> {
    const PROBE_BYTES: usize = 4096;
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    if coordinates.size_bytes < PROBE_BYTES as u64 {
        return Err("Selected partition is too small to inspect safely.".to_string());
    }
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path}. Open FCM Desktop as Administrator only if Windows denies read-only access: {error}"))?;
    device.seek(SeekFrom::Start(coordinates.offset_bytes)).map_err(|error| format!("Could not seek to partition start: {error}"))?;
    let mut bytes = vec![0_u8; PROBE_BYTES];
    device.read_exact(&mut bytes).map_err(|error| format!("Could not read partition header: {error}"))?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let signature = bytes[..32].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let format_hint = if bytes.starts_with(b"DHFS4.1\0") {
        "Dahua DHFS 4.1 filesystem header"
    } else if bytes.get(1080..1082) == Some(&[0x53, 0xef]) {
        "ext4 filesystem signature"
    } else if bytes.starts_with(b"NTFS    ") {
        "NTFS filesystem signature"
    } else if bytes.starts_with(&[0xeb, 0x3c, 0x90]) || bytes.starts_with(&[0xeb, 0x58, 0x90]) {
        "FAT-compatible boot sector"
    } else {
        "No recognised filesystem header: possible proprietary DVR container or encrypted data"
    }.to_string();
    Ok(PartitionProbe { disk_number, partition_number, offset_bytes: coordinates.offset_bytes, bytes_read: PROBE_BYTES, sha256, signature, format_hint })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn probe_indexed_cluster(disk_number: u32, partition_number: u32, cluster_number: i64) -> Result<ClusterMappingReport, String> {
    const SAMPLE_BYTES: usize = 4096;
    const CANDIDATE_MULTIPLIERS: [u64; 4] = [512, 4096, 65536, 1048576];
    if cluster_number < 0 {
        return Err("Cluster number must not be negative.".to_string());
    }
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path}. Open FCM Desktop as Administrator only if Windows denies read-only access: {error}"))?;
    let mut samples = Vec::new();
    for multiplier_bytes in CANDIDATE_MULTIPLIERS {
        let relative_offset = (cluster_number as u64).checked_mul(multiplier_bytes)
            .ok_or_else(|| "Cluster offset overflowed.".to_string())?;
        if relative_offset.saturating_add(SAMPLE_BYTES as u64) > coordinates.size_bytes {
            continue;
        }
        let absolute_offset_bytes = coordinates.offset_bytes.saturating_add(relative_offset);
        device.seek(SeekFrom::Start(absolute_offset_bytes)).map_err(|error| format!("Could not seek to candidate offset: {error}"))?;
        let mut bytes = vec![0_u8; SAMPLE_BYTES];
        device.read_exact(&mut bytes).map_err(|error| format!("Could not read candidate offset: {error}"))?;
        samples.push(ClusterSample {
            multiplier_bytes,
            absolute_offset_bytes,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            signature: bytes[..32].iter().map(|byte| format!("{byte:02x}")).collect(),
            format_hint: media_signature_hint(&bytes),
        });
    }
    Ok(ClusterMappingReport { disk_number, partition_number, cluster_number, samples })
}

#[derive(Serialize)]
struct DhfsMetadataScan {
    disk_number: u32,
    partition_number: u32,
    bytes_scanned: usize,
    dhfs_marker_offsets: Vec<u64>,
    non_zero_block_offsets: Vec<u64>,
    truncated: bool,
}

#[derive(Serialize)]
struct DhfsHeaderBlock {
    absolute_offset_bytes: u64,
    sha256: String,
    ascii_preview: String,
    hex_preview: String,
}

#[derive(Serialize)]
struct DhfsHeaderReport {
    disk_number: u32,
    partition_number: u32,
    headers: Vec<DhfsHeaderBlock>,
}

#[derive(Serialize)]
struct DhfsDptField {
    relative_offset_bytes: usize,
    little_endian_u32: u32,
    big_endian_u32: u32,
}

#[derive(Serialize)]
struct DhfsDptReport {
    disk_number: u32,
    partition_number: u32,
    dpt_header_offsets: Vec<u64>,
    headers_identical: bool,
    differing_byte_offsets: Vec<usize>,
    non_zero_u32_fields: Vec<DhfsDptField>,
}

#[derive(Serialize)]
struct ExportTool {
    name: String,
    executable_path: String,
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn scan_dhfs_metadata(disk_number: u32, partition_number: u32) -> Result<DhfsMetadataScan, String> {
    const SCAN_BYTES: usize = 16 * 1024 * 1024;
    const BLOCK_BYTES: usize = 4096;
    const MAX_REPORTED_OFFSETS: usize = 64;
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let bytes_scanned = usize::try_from(coordinates.size_bytes.min(SCAN_BYTES as u64)).map_err(|error| error.to_string())?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path}. Open FCM Desktop as Administrator only if Windows denies read-only access: {error}"))?;
    device.seek(SeekFrom::Start(coordinates.offset_bytes)).map_err(|error| format!("Could not seek to partition start: {error}"))?;
    let mut bytes = vec![0_u8; bytes_scanned];
    device.read_exact(&mut bytes).map_err(|error| format!("Could not read DHFS metadata window: {error}"))?;
    let mut dhfs_marker_offsets = Vec::new();
    for (offset, window) in bytes.windows(4).enumerate() {
        if window == b"DHFS" && dhfs_marker_offsets.len() < MAX_REPORTED_OFFSETS {
            dhfs_marker_offsets.push(coordinates.offset_bytes.saturating_add(offset as u64));
        }
    }
    let mut non_zero_block_offsets = Vec::new();
    for (index, block) in bytes.chunks(BLOCK_BYTES).enumerate() {
        if block.iter().any(|byte| *byte != 0) && non_zero_block_offsets.len() < MAX_REPORTED_OFFSETS {
            non_zero_block_offsets.push(coordinates.offset_bytes.saturating_add((index * BLOCK_BYTES) as u64));
        }
    }
    Ok(DhfsMetadataScan {
        disk_number,
        partition_number,
        bytes_scanned,
        dhfs_marker_offsets,
        non_zero_block_offsets,
        truncated: bytes_scanned == SCAN_BYTES,
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn inspect_dhfs_headers(disk_number: u32, partition_number: u32) -> Result<DhfsHeaderReport, String> {
    const SCAN_BYTES: usize = 64 * 1024;
    const HEADER_BYTES: usize = 4096;
    const PREVIEW_BYTES: usize = 128;
    const MAX_HEADERS: usize = 8;
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path}. Open FCM Desktop as Administrator only if Windows denies read-only access: {error}"))?;
    device.seek(SeekFrom::Start(coordinates.offset_bytes)).map_err(|error| format!("Could not seek to DHFS metadata: {error}"))?;
    let mut scan = vec![0_u8; SCAN_BYTES];
    device.read_exact(&mut scan).map_err(|error| format!("Could not read DHFS header window: {error}"))?;
    let marker_offsets = scan.windows(4).enumerate().filter_map(|(offset, window)| (window == b"DHFS").then_some(offset)).take(MAX_HEADERS).collect::<Vec<_>>();
    if marker_offsets.is_empty() {
        return Err("No DHFS markers found in the first 64 KB of the selected partition.".to_string());
    }
    let mut headers = Vec::new();
    for relative_offset in marker_offsets {
        let absolute_offset_bytes = coordinates.offset_bytes.saturating_add(relative_offset as u64);
        let end_offset = relative_offset.saturating_add(HEADER_BYTES);
        if end_offset > scan.len() {
            continue;
        }
        let bytes = &scan[relative_offset..end_offset];
        let preview = &bytes[..PREVIEW_BYTES];
        let ascii_preview = preview.iter().map(|byte| if byte.is_ascii_graphic() || *byte == b' ' { *byte as char } else { '.' }).collect();
        let hex_preview = preview.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" ");
        headers.push(DhfsHeaderBlock { absolute_offset_bytes, sha256: format!("{:x}", Sha256::digest(&bytes)), ascii_preview, hex_preview });
    }
    Ok(DhfsHeaderReport { disk_number, partition_number, headers })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn inspect_dhfs_dpt(disk_number: u32, partition_number: u32) -> Result<DhfsDptReport, String> {
    const SCAN_BYTES: usize = 64 * 1024;
    const HEADER_BYTES: usize = 4096;
    const MAX_FIELDS: usize = 64;
    const MAX_DIFFERENCES: usize = 64;
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path}. Open FCM Desktop as Administrator only if Windows denies read-only access: {error}"))?;
    device.seek(SeekFrom::Start(coordinates.offset_bytes)).map_err(|error| format!("Could not seek to DHFS metadata: {error}"))?;
    let mut scan = vec![0_u8; SCAN_BYTES];
    device.read_exact(&mut scan).map_err(|error| format!("Could not read DHFS DPT window: {error}"))?;
    let marker_offsets = scan.windows(12).enumerate().filter_map(|(offset, window)| (window.starts_with(b"DHFS_DPT:")).then_some(offset)).take(2).collect::<Vec<_>>();
    if marker_offsets.len() < 2 {
        return Err("Two DHFS_DPT metadata copies were not found in the first 64 KB of the selected partition.".to_string());
    }
    let first_end = marker_offsets[0].saturating_add(HEADER_BYTES);
    let second_end = marker_offsets[1].saturating_add(HEADER_BYTES);
    if first_end > scan.len() || second_end > scan.len() {
        return Err("DHFS_DPT header extends outside the bounded metadata window.".to_string());
    }
    let first = &scan[marker_offsets[0]..first_end];
    let second = &scan[marker_offsets[1]..second_end];
    let differing_byte_offsets = first.iter().zip(second.iter()).enumerate().filter_map(|(offset, (left, right))| (left != right).then_some(offset)).take(MAX_DIFFERENCES).collect::<Vec<_>>();
    let mut non_zero_u32_fields = Vec::new();
    for (offset, bytes) in first.windows(4).step_by(4).enumerate() {
        let little_endian_u32 = u32::from_le_bytes(bytes.try_into().expect("window size is fixed"));
        if little_endian_u32 != 0 && non_zero_u32_fields.len() < MAX_FIELDS {
            non_zero_u32_fields.push(DhfsDptField {
                relative_offset_bytes: offset * 4,
                little_endian_u32,
                big_endian_u32: u32::from_be_bytes(bytes.try_into().expect("window size is fixed")),
            });
        }
    }
    Ok(DhfsDptReport {
        disk_number,
        partition_number,
        dpt_header_offsets: marker_offsets.iter().map(|offset| coordinates.offset_bytes.saturating_add(*offset as u64)).collect(),
        headers_identical: differing_byte_offsets.is_empty(),
        differing_byte_offsets,
        non_zero_u32_fields,
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn detect_dahua_export_tools() -> Result<Vec<ExportTool>, String> {
        use std::process::Command;

        let script = r#"
            $patterns = @('*SmartPlayer*.exe', '*SmartPSS*.exe', '*Dahua*.exe', '*DiskManager*.exe')
            $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
            $found = @()
            foreach ($root in $roots) {
                foreach ($pattern in $patterns) {
                    $found += @(Get-ChildItem -Path $root -Filter $pattern -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 8)
                }
            }
            @($found | Sort-Object FullName -Unique | ForEach-Object { [pscustomobject]@{ name = $_.BaseName; executable_path = $_.FullName } }) | ConvertTo-Json -Compress
        "#;
        let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .map_err(|error| format!("Could not inspect installed Dahua export tools: {error}"))?;
        if !output.status.success() {
                return Err(format!("Dahua tool detection failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let body = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        if body.trim().is_empty() || body.trim() == "null" {
                return Ok(Vec::new());
        }
        serde_json::from_str(&body).map_err(|error| format!("Could not parse Dahua tool inventory: {error}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn analyse_inserted_sd_card() -> Result<SdCardAnalysis, String> {
    let disks = detect_removable_disks()?;
    let Some(disk) = disks.iter().find(|disk| !disk.partitions.is_empty()) else {
        return Ok(SdCardAnalysis { disks, index_report: None, hidden_partition: None, cluster_report: None, summary: "No removable SD card or USB disk was detected.".to_string() });
    };
    let hidden_partition = disk.partitions.iter().filter(|partition| partition.drive_letter.is_none()).max_by_key(|partition| partition.size_bytes).cloned();
    let index_path = disk.partitions.iter().filter_map(|partition| partition.drive_letter.as_ref()).find_map(|letter| {
        let root = PathBuf::from(format!("{letter}:\\"));
        let mut stack = vec![root];
        while let Some(directory) = stack.pop() {
            let entries = fs::read_dir(&directory).ok()?;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("SDFileInfo.db")) {
                    return Some(path);
                }
                if entry.metadata().ok()?.is_dir() { stack.push(path); }
            }
        }
        None
    });
    let index_report = index_path.as_deref().map(inspect_sd_index_at_path).transpose()?;
    let cluster_report = match (&index_report, &hidden_partition) {
        (Some(index), Some(partition)) => index.records.iter().find(|record| record.cluster_number > 0)
            .map(|record| probe_indexed_cluster(disk.disk_number, partition.partition_number, record.cluster_number)).transpose()?,
        _ => None,
    };
    let summary = match (&index_report, &hidden_partition, &cluster_report) {
        (Some(index), Some(partition), Some(cluster)) => format!("Found {} indexed recordings and unmounted partition {}. Tested indexed cluster {} at {} candidate offsets.", index.valid_timestamped_record_count, partition.partition_number, cluster.cluster_number, cluster.samples.len()),
        (None, Some(partition), _) => format!("Found unmounted partition {}, but SDFileInfo.db was not found on a mounted partition.", partition.partition_number),
        (Some(index), None, _) => format!("Found {} indexed recordings, but no unmounted recording partition was found.", index.valid_timestamped_record_count),
        _ => "No compatible SD-card index and hidden recording partition pair was found.".to_string(),
    };
    Ok(SdCardAnalysis { disks, index_report, hidden_partition, cluster_report, summary })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn probe_partition_header(_disk_number: u32, _partition_number: u32) -> Result<PartitionProbe, String> {
    Err("Partition header probing is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn probe_indexed_cluster(_disk_number: u32, _partition_number: u32, _cluster_number: i64) -> Result<ClusterMappingReport, String> {
    Err("Indexed cluster probing is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn scan_dhfs_metadata(_disk_number: u32, _partition_number: u32) -> Result<DhfsMetadataScan, String> {
    Err("DHFS metadata scanning is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn inspect_dhfs_headers(_disk_number: u32, _partition_number: u32) -> Result<DhfsHeaderReport, String> {
    Err("DHFS header inspection is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn inspect_dhfs_dpt(_disk_number: u32, _partition_number: u32) -> Result<DhfsDptReport, String> {
    Err("DHFS DPT inspection is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn detect_dahua_export_tools() -> Result<Vec<ExportTool>, String> {
    Err("Dahua tool detection is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn analyse_inserted_sd_card() -> Result<SdCardAnalysis, String> {
    Err("Automated SD-card analysis is available in the Windows FCM Desktop application.".to_string())
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
    inspect_sd_index_at_path(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![analyse_inserted_sd_card, detect_removable_disks, probe_partition_header, probe_indexed_cluster, scan_dhfs_metadata, inspect_dhfs_headers, inspect_dhfs_dpt, detect_dahua_export_tools, inspect_mounted_folder, inspect_sd_index])
        .run(tauri::generate_context!())
        .expect("error while running FCM SD Card Bridge");
}