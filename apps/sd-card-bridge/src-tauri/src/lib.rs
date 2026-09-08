use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
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
struct DhfsVideoExport {
    file_name: String,
    partition: usize,
    descriptor: u32,
    channel: u32,
    start_time: String,
    end_time: String,
    bytes_written: u64,
    starts_with_nal_marker: bool,
}

#[derive(Serialize)]
struct DhfsConversionReport {
    source_path: String,
    source_sha256: String,
    output_directory: String,
    exported: Vec<DhfsVideoExport>,
}

#[derive(Serialize)]
struct DhfsImageReport {
    disk_number: u32,
    partition_number: u32,
    output_path: String,
    bytes_copied: u64,
    sha256: String,
}

#[derive(Serialize)]
struct CachedClipReport {
    cache_path: String,
    bytes: u64,
    sha256: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    starts_with_nal_marker: Option<bool>,
}

#[derive(Serialize)]
struct DestinationSpaceReport {
    drive: String,
    free_bytes: u64,
    required_bytes: u64,
    sufficient: bool,
}

#[derive(Serialize)]
struct PhysicalDhfsRecording {
    partition_number: u32,
    dhfs_partition_index: u32,
    descriptor: u32,
    channel: u32,
    start_time: String,
    end_time: String,
    fragment_count: u32,
    bytes: u64,
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

#[tauri::command]
fn cache_video_clip(source_path: String, cache_directory: String, cache_name: String) -> Result<CachedClipReport, String> {
    let source = PathBuf::from(&source_path);
    let cache_dir = PathBuf::from(&cache_directory);
    if !source.is_file() { return Err("The selected recording is no longer available.".to_string()); }
    if cache_name.is_empty() || cache_name.contains(['/', '\\']) || !cache_name.ends_with(".h264") {
        return Err("Invalid cache clip name.".to_string());
    }
    fs::create_dir_all(&cache_dir).map_err(|error| format!("Could not create clip cache: {error}"))?;
    let ready_path = cache_dir.join(&cache_name);
    let part_path = cache_dir.join(format!("{cache_name}.part"));
    let mut input = File::open(&source).map_err(|error| format!("Could not open selected recording: {error}"))?;
    let mut output = File::create(&part_path).map_err(|error| format!("Could not create clip cache: {error}"))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    let mut nal_marker = false;
    loop {
        let read = input.read(&mut buffer).map_err(|error| format!("Recording read failed; partial cache retained: {error}"))?;
        if read == 0 { break; }
        if bytes == 0 { nal_marker = starts_with_nal_marker(&buffer[..read]); }
        output.write_all(&buffer[..read]).map_err(|error| format!("Clip cache write failed; partial cache retained: {error}"))?;
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    output.flush().map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&part_path, &ready_path).map_err(|error| format!("Could not commit clip cache atomically: {error}"))?;
    Ok(CachedClipReport { cache_path: ready_path.to_string_lossy().to_string(), bytes, sha256: format!("{:x}", hasher.finalize()), state: "ready".to_string(), channel: None, start_time: None, end_time: None, starts_with_nal_marker: Some(nal_marker) })
}

#[tauri::command]
fn clear_cached_clip(cache_path: String) -> Result<(), String> {
    let path = PathBuf::from(&cache_path);
    if path.exists() { fs::remove_file(path).map_err(|error| format!("Could not clear clip cache: {error}"))?; }
    Ok(())
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

// Confirms the reconstructed fragment offset lands exactly on an H.264/H.265 NAL boundary.
fn starts_with_nal_marker(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0, 0, 0, 1]) || bytes.starts_with(&[0, 0, 1])
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
fn check_destination_free_space(output_path: String, required_bytes: u64) -> Result<DestinationSpaceReport, String> {
    use std::process::Command;

    let normalized = output_path.replace('/', "\\");
    let drive = normalized.get(0..2).filter(|prefix| prefix.ends_with(':')).ok_or("Choose a destination on a lettered drive, such as C:\\ or an external drive.")?.to_ascii_uppercase();
    let script = format!("(New-Object System.IO.DriveInfo('{drive}\\')).AvailableFreeSpace");
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("Could not check free space on {drive}: {error}"))?;
    if !output.status.success() {
        return Err(format!("Could not check free space on {drive}: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let free_bytes: u64 = String::from_utf8_lossy(&output.stdout).trim().parse().map_err(|error| format!("Could not parse free space on {drive}: {error}"))?;
    Ok(DestinationSpaceReport { drive, free_bytes, required_bytes, sufficient: free_bytes > required_bytes })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn image_dhfs_partition(disk_number: u32, partition_number: u32, output_path: String) -> Result<DhfsImageReport, String> {
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    if coordinates.size_bytes < 4096 { return Err("Selected partition is too small to be a DHFS recording partition.".to_string()); }
    let normalized_output = output_path.replace('/', "\\").to_ascii_uppercase();
    let removable_disks = detect_removable_disks()?;
    for removable_disk in removable_disks {
        if removable_disk.disk_number != disk_number { continue; }
        for partition in removable_disk.partitions {
            if let Some(letter) = partition.drive_letter {
                let drive_prefix = format!("{}:\\", letter.to_ascii_uppercase());
                if normalized_output.starts_with(&drive_prefix) {
                    return Err(format!("Choose a local computer drive, not the SD card ({letter}:). The DHFS image needs about {} GB of free space.", coordinates.size_bytes / 1024 / 1024 / 1024));
                }
            }
        }
    }
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not open {device_path} read-only: {error}"))?;
    let magic = read_device_aligned(&mut device, coordinates.offset_bytes, 7)?;
    if magic != b"DHFS4.1" {
        return Err("This partition does not begin with a DHFS4.1 signature. Analyse the card again to confirm the correct partition.".to_string());
    }
    let mut image = OpenOptions::new().write(true).create_new(true).open(&output_path)
        .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("A file already exists at {output_path}. Choose a new file name or delete the existing file before imaging again.")
        } else {
            format!("Could not create the image file: {error}")
        })?;
    let mut hasher = Sha256::new();
    let mut current_offset = coordinates.offset_bytes;
    let mut remaining = coordinates.size_bytes;
    const CHUNK_BYTES: u64 = 4 * 1024 * 1024;
    while remaining > 0 {
        let requested = remaining.min(CHUNK_BYTES) as usize;
        let chunk = read_device_aligned(&mut device, current_offset, requested)
            .map_err(|error| format!("Read-only DHFS imaging failed: {error}"))?;
        image.write_all(&chunk).map_err(|error| format!("Writing DHFS image failed: {error}"))?;
        hasher.update(&chunk);
        current_offset += requested as u64;
        remaining -= requested as u64;
    }
    image.flush().map_err(|error| error.to_string())?;
    Ok(DhfsImageReport { disk_number, partition_number, output_path, bytes_copied: coordinates.size_bytes, sha256: format!("{:x}", hasher.finalize()) })
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

#[derive(Deserialize, Serialize)]
struct ExportTool {
    name: String,
    executable_path: String,
}

fn dhfs_read_u32(file: &mut File, offset: u64) -> Result<u32, String> {
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn dhfs_read_descriptor(file: &mut File, offset: u64) -> Result<[u8; 32], String> {
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut descriptor = [0_u8; 32];
    file.read_exact(&mut descriptor).map_err(|error| error.to_string())?;
    Ok(descriptor)
}

fn dhfs_timestamp(timestamp: u32) -> String {
    let bits = |position: u32, size: u32| (timestamp >> (position + 1 - size)) & ((1_u32 << size) - 1);
    format!("20{:02}-{:02}-{:02}_{:02}-{:02}-{:02}", bits(31, 6), bits(25, 4), bits(21, 5), bits(16, 5), bits(11, 6), bits(5, 6))
}

fn dhfs_descriptor_chain(file: &mut File, descriptor_offset: u64, descriptor_count: u32, start: u32) -> Result<Vec<u32>, String> {
    let mut chain = Vec::new();
    let mut current = start;
    loop {
        if current == u32::MAX || current >= descriptor_count { break; }
        if chain.contains(&current) { return Err("DHFS descriptor chain is cyclic.".to_string()); }
        chain.push(current);
        let descriptor = dhfs_read_descriptor(file, descriptor_offset + current as u64 * 32)?;
        let next = u32::from_le_bytes(descriptor[12..16].try_into().expect("DHFS next descriptor field"));
        if chain.len() > descriptor_count as usize { return Err("DHFS descriptor chain is invalid.".to_string()); }
        if next == 0 { break; }
        current = next;
    }
    if chain.is_empty() { return Err("DHFS recording has no fragments.".to_string()); }
    Ok(chain)
}

// Windows raw \\.\PhysicalDriveN handles generally reject reads whose offset or length is not sector-aligned.
const DEVICE_READ_ALIGNMENT: u64 = 4096;

fn read_device_aligned(device: &mut File, absolute_offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let aligned_start = (absolute_offset / DEVICE_READ_ALIGNMENT) * DEVICE_READ_ALIGNMENT;
    let aligned_end = (absolute_offset + length as u64).div_ceil(DEVICE_READ_ALIGNMENT) * DEVICE_READ_ALIGNMENT;
    let aligned_len = (aligned_end - aligned_start) as usize;
    device.seek(SeekFrom::Start(aligned_start))
        .map_err(|error| format!("Card seek failed at sector-aligned offset {aligned_start}: {error}"))?;
    let mut aligned_buffer = vec![0_u8; aligned_len];
    device.read_exact(&mut aligned_buffer)
        .map_err(|error| format!("Card read failed at sector-aligned offset {aligned_start}, length {aligned_len} (requested {length} bytes at {absolute_offset}): {error}"))?;
    let start_within = (absolute_offset - aligned_start) as usize;
    Ok(aligned_buffer[start_within..start_within + length].to_vec())
}

fn read_device_u32(device: &mut File, absolute_offset: u64) -> Result<u32, String> {
    let bytes = read_device_aligned(device, absolute_offset, 4)?;
    Ok(u32::from_le_bytes(bytes.try_into().expect("aligned read returns exactly the requested length")))
}

fn read_device_descriptor(device: &mut File, absolute_offset: u64) -> Result<[u8; 32], String> {
    let bytes = read_device_aligned(device, absolute_offset, 32)?;
    Ok(bytes.try_into().expect("aligned read returns exactly the requested length"))
}

fn device_descriptor_chain(device: &mut File, descriptor_offset: u64, descriptor_count: u32, start: u32) -> Result<Vec<u32>, String> {
    let mut chain = Vec::new();
    let mut current = start;
    loop {
        if current == u32::MAX || current >= descriptor_count { break; }
        if chain.contains(&current) { return Err("DHFS descriptor chain is cyclic.".to_string()); }
        chain.push(current);
        let descriptor = read_device_descriptor(device, descriptor_offset + current as u64 * 32)?;
        let next = u32::from_le_bytes(descriptor[12..16].try_into().expect("DHFS next descriptor field"));
        if chain.len() > descriptor_count as usize { return Err("DHFS descriptor chain is invalid.".to_string()); }
        if next == 0 { break; }
        current = next;
    }
    if chain.is_empty() { return Err("DHFS recording has no fragments.".to_string()); }
    Ok(chain)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn list_dhfs_partition_recordings(disk_number: u32, partition_number: u32) -> Result<Vec<PhysicalDhfsRecording>, String> {
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path} read-only: {error}"))?;
    let base = coordinates.offset_bytes;
    let magic = read_device_aligned(&mut device, base, 7)?;
    if magic != b"DHFS4.1" { return Err("The selected partition is not DHFS4.1.".to_string()); }

    let mut table_offset = base + 0x3c00 + 0x34;
    let mut partitions = Vec::new();
    for _ in 0..64 {
        let entry = read_device_aligned(&mut device, table_offset, 64)?;
        if &entry[..4] == [0xaa, 0x55, 0xaa, 0x55] { break; }
        let superblock_offset = u32::from_le_bytes(entry[20..24].try_into().expect("DHFS superblock field")) as u64 * 512;
        let partition_offset = u64::from_le_bytes(entry[48..56].try_into().expect("DHFS partition field")) * 512;
        if partition_offset == 0 { break; }
        partitions.push((partition_offset, superblock_offset));
        table_offset += 64;
    }
    if partitions.is_empty() { return Err("No DHFS partitions were found on this card.".to_string()); }
    let mut recordings = Vec::new();
    for (partition_index, (partition_offset, superblock_offset)) in partitions.iter().enumerate() {
        let superblock = base + partition_offset + superblock_offset;
        let block_size = read_device_u32(&mut device, superblock + 0x2c)? as u64;
        let fragment_size = read_device_u32(&mut device, superblock + 0x30)? as u64 * block_size;
        let descriptor_offset = base + partition_offset + read_device_u32(&mut device, superblock + 0x44)? as u64 * block_size;
        let descriptor_count = read_device_u32(&mut device, superblock + 0x4c)?;
        if block_size == 0 || fragment_size == 0 || descriptor_count == 0 { continue; }
        for descriptor_index in 0..descriptor_count {
            let descriptor = read_device_descriptor(&mut device, descriptor_offset + descriptor_index as u64 * 32)?;
            if descriptor[0] != 1 { continue; }
            let start = u32::from_le_bytes(descriptor[4..8].try_into().expect("DHFS start timestamp"));
            let end = u32::from_le_bytes(descriptor[8..12].try_into().expect("DHFS end timestamp"));
            if start == end { continue; }
            let chain = device_descriptor_chain(&mut device, descriptor_offset, descriptor_count, descriptor_index)?;
            let last = read_device_descriptor(&mut device, descriptor_offset + *chain.last().expect("non-empty chain") as u64 * 32)?;
            let last_size = u32::from_le_bytes(last[16..20].try_into().expect("DHFS final fragment size")) as u64 * block_size;
            if last_size == 0 || last_size > fragment_size { continue; }
            recordings.push(PhysicalDhfsRecording {
                partition_number,
                dhfs_partition_index: partition_index as u32,
                descriptor: descriptor_index,
                channel: descriptor[1].saturating_sub(b'0') as u32 + 1,
                start_time: dhfs_timestamp(start),
                end_time: dhfs_timestamp(end),
                fragment_count: chain.len() as u32,
                bytes: (chain.len().saturating_sub(1) as u64 * fragment_size) + last_size,
            });
        }
    }
    Ok(recordings)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn extract_dhfs_recording_to_cache(disk_number: u32, partition_number: u32, dhfs_partition_index: u32, descriptor_index: u32, cache_directory: String) -> Result<CachedClipReport, String> {
    let coordinates = partition_coordinates(disk_number, partition_number)?;
    let device_path = format!(r"\\.\PhysicalDrive{disk_number}");
    let mut device = OpenOptions::new().read(true).write(false).open(&device_path)
        .map_err(|error| format!("Could not read {device_path} read-only: {error}"))?;
    let base = coordinates.offset_bytes;
    let magic = read_device_aligned(&mut device, base, 7)?;
    if magic != b"DHFS4.1" { return Err("The selected partition is not DHFS4.1.".to_string()); }

    let mut table_offset = base + 0x3c00 + 0x34;
    let mut partitions = Vec::new();
    for _ in 0..64 {
        let entry = read_device_aligned(&mut device, table_offset, 64)?;
        if &entry[..4] == [0xaa, 0x55, 0xaa, 0x55] { break; }
        let superblock_offset = u32::from_le_bytes(entry[20..24].try_into().expect("DHFS superblock field")) as u64 * 512;
        let partition_offset = u64::from_le_bytes(entry[48..56].try_into().expect("DHFS partition field")) * 512;
        if partition_offset == 0 { break; }
        partitions.push((partition_offset, superblock_offset));
        table_offset += 64;
    }
    let (partition_offset, superblock_offset) = partitions.get(dhfs_partition_index as usize)
        .ok_or("The selected DHFS partition is no longer present on this card.")?;
    let superblock = base + partition_offset + superblock_offset;
    let block_size = read_device_u32(&mut device, superblock + 0x2c)? as u64;
    let fragment_size = read_device_u32(&mut device, superblock + 0x30)? as u64 * block_size;
    let descriptor_offset = base + partition_offset + read_device_u32(&mut device, superblock + 0x44)? as u64 * block_size;
    let video_offset = base + partition_offset + read_device_u32(&mut device, superblock + 0x48)? as u64 * block_size;
    let descriptor_count = read_device_u32(&mut device, superblock + 0x4c)?;
    if block_size == 0 || fragment_size == 0 || descriptor_index >= descriptor_count {
        return Err("The selected recording is no longer valid on this card.".to_string());
    }

    let descriptor = read_device_descriptor(&mut device, descriptor_offset + descriptor_index as u64 * 32)?;
    if descriptor[0] != 1 { return Err("The selected descriptor is not a normal recording.".to_string()); }
    let start = u32::from_le_bytes(descriptor[4..8].try_into().expect("DHFS start timestamp"));
    let end = u32::from_le_bytes(descriptor[8..12].try_into().expect("DHFS end timestamp"));
    let channel = descriptor[1].saturating_sub(b'0') as u32 + 1;
    let chain = device_descriptor_chain(&mut device, descriptor_offset, descriptor_count, descriptor_index)?;
    let last = read_device_descriptor(&mut device, descriptor_offset + *chain.last().expect("non-empty chain") as u64 * 32)?;
    let last_size = u32::from_le_bytes(last[16..20].try_into().expect("DHFS final fragment size")) as u64 * block_size;
    if last_size == 0 || last_size > fragment_size { return Err("The selected recording's final fragment size is invalid.".to_string()); }

    let start_time = dhfs_timestamp(start);
    let end_time = dhfs_timestamp(end);
    let cache_name = format!("FCM-card-p{dhfs_partition_index}-d{descriptor_index:06}-{start_time}-{end_time}-ch{channel:02}.h264");
    let cache_dir = PathBuf::from(&cache_directory);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("Could not create clip cache: {error}"))?;
    let ready_path = cache_dir.join(&cache_name);
    let part_path = cache_dir.join(format!("{cache_name}.part"));
    let mut output_file = File::create(&part_path).map_err(|error| format!("Could not create clip cache: {error}"))?;
    let mut hasher = Sha256::new();
    let mut bytes_written = 0_u64;
    let mut nal_marker = false;
    const READ_CHUNK: u64 = 1024 * 1024;
    for (position, fragment) in chain.iter().enumerate() {
        let bytes_to_copy = if position + 1 == chain.len() { last_size } else { fragment_size };
        let fragment_start = video_offset + *fragment as u64 * fragment_size;
        let mut copied = 0_u64;
        while copied < bytes_to_copy {
            let requested = (bytes_to_copy - copied).min(READ_CHUNK) as usize;
            let chunk = read_device_aligned(&mut device, fragment_start + copied, requested)
                .map_err(|error| format!("Card read failed, possibly disconnected; partial cache retained: {error}"))?;
            if bytes_written == 0 { nal_marker = starts_with_nal_marker(&chunk); }
            output_file.write_all(&chunk).map_err(|error| format!("Clip cache write failed; partial cache retained: {error}"))?;
            hasher.update(&chunk);
            copied += requested as u64;
            bytes_written += requested as u64;
        }
    }
    output_file.flush().map_err(|error| error.to_string())?;
    output_file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&part_path, &ready_path).map_err(|error| format!("Could not commit clip cache atomically: {error}"))?;
    Ok(CachedClipReport {
        cache_path: ready_path.to_string_lossy().to_string(),
        bytes: bytes_written,
        sha256: format!("{:x}", hasher.finalize()),
        state: "ready".to_string(),
        channel: Some(channel),
        start_time: Some(start_time),
        end_time: Some(end_time),
        starts_with_nal_marker: Some(nal_marker),
    })
}

#[tauri::command]
fn convert_dhfs_image(image_path: String, output_directory: String) -> Result<DhfsConversionReport, String> {
    let image = PathBuf::from(&image_path);
    let output = PathBuf::from(&output_directory);
    if !image.is_file() { return Err("Select a DHFS disk or partition image.".to_string()); }
    if !output.is_dir() { return Err("Select an existing output folder.".to_string()); }

    let source_sha256 = sha256_file(&image)?;
    let mut file = File::open(&image).map_err(|error| format!("Could not open DHFS image read-only: {error}"))?;
    let mut magic = [0_u8; 7];
    file.read_exact(&mut magic).map_err(|error| error.to_string())?;
    if &magic != b"DHFS4.1" { return Err("The selected image is not a DHFS4.1 image.".to_string()); }

    let mut table_offset = 0x3c00_u64 + 0x34;
    let mut partitions = Vec::new();
    for _ in 0..64 {
        file.seek(SeekFrom::Start(table_offset)).map_err(|error| error.to_string())?;
        let mut entry = [0_u8; 64];
        file.read_exact(&mut entry).map_err(|error| error.to_string())?;
        if &entry[..4] == [0xaa, 0x55, 0xaa, 0x55] { break; }
        let superblock_offset = u32::from_le_bytes(entry[20..24].try_into().expect("DHFS superblock field")) as u64 * 512;
        let partition_offset = u64::from_le_bytes(entry[48..56].try_into().expect("DHFS partition field")) * 512;
        if partition_offset == 0 { break; }
        partitions.push((partition_offset, superblock_offset));
        table_offset += 64;
    }
    if partitions.is_empty() { return Err("No DHFS partitions were found in the image.".to_string()); }

    let mut exported = Vec::new();
    for (partition_index, (partition_offset, superblock_offset)) in partitions.iter().enumerate() {
        let superblock = partition_offset + superblock_offset;
        let block_size = dhfs_read_u32(&mut file, superblock + 0x2c)? as u64;
        let fragment_size = dhfs_read_u32(&mut file, superblock + 0x30)? as u64 * block_size;
        let descriptor_offset = partition_offset + dhfs_read_u32(&mut file, superblock + 0x44)? as u64 * block_size;
        let video_offset = partition_offset + dhfs_read_u32(&mut file, superblock + 0x48)? as u64 * block_size;
        let descriptor_count = dhfs_read_u32(&mut file, superblock + 0x4c)?;
        if block_size == 0 || fragment_size == 0 || descriptor_count == 0 { continue; }

        for descriptor_index in 0..descriptor_count {
            let descriptor = dhfs_read_descriptor(&mut file, descriptor_offset + descriptor_index as u64 * 32)?;
            if descriptor[0] != 1 { continue; }
            let start_timestamp = u32::from_le_bytes(descriptor[4..8].try_into().expect("DHFS start timestamp"));
            let end_timestamp = u32::from_le_bytes(descriptor[8..12].try_into().expect("DHFS end timestamp"));
            if start_timestamp == end_timestamp { continue; }
            let chain = dhfs_descriptor_chain(&mut file, descriptor_offset, descriptor_count, descriptor_index)?;
            let last = dhfs_read_descriptor(&mut file, descriptor_offset + *chain.last().expect("non-empty chain") as u64 * 32)?;
            let last_size = u32::from_le_bytes(last[16..20].try_into().expect("DHFS final fragment size")) as u64 * block_size;
            if last_size == 0 || last_size > fragment_size { continue; }

            let channel = descriptor[1].saturating_sub(b'0') as u32 + 1;
            let start_time = dhfs_timestamp(start_timestamp);
            let end_time = dhfs_timestamp(end_timestamp);
            let file_name = format!("FCM-p{}-d{:06}-{}-{}-ch{:02}.h264", partition_index, descriptor_index, start_time, end_time, channel);
            let output_path = output.join(&file_name);
            let mut output_file = File::create(&output_path).map_err(|error| format!("Could not create {output_path:?}: {error}"))?;
            let mut bytes_written = 0_u64;
            let mut nal_marker = false;
            for (position, fragment) in chain.iter().enumerate() {
                let bytes_to_copy = if position + 1 == chain.len() { last_size } else { fragment_size };
                file.seek(SeekFrom::Start(video_offset + *fragment as u64 * fragment_size)).map_err(|error| error.to_string())?;
                let mut remaining = bytes_to_copy;
                let mut buffer = [0_u8; 64 * 1024];
                while remaining > 0 {
                    let requested = remaining.min(buffer.len() as u64) as usize;
                    file.read_exact(&mut buffer[..requested]).map_err(|error| error.to_string())?;
                    if bytes_written == 0 { nal_marker = starts_with_nal_marker(&buffer[..requested]); }
                    output_file.write_all(&buffer[..requested]).map_err(|error| error.to_string())?;
                    remaining -= requested as u64;
                    bytes_written += requested as u64;
                }
            }
            exported.push(DhfsVideoExport { file_name, partition: partition_index, descriptor: descriptor_index, channel, start_time, end_time, bytes_written, starts_with_nal_marker: nal_marker });
        }
    }
    Ok(DhfsConversionReport { source_path: image_path, source_sha256, output_directory, exported })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn launch_dahua_export_tool(executable_path: String) -> Result<(), String> {
    use std::process::Command;

    let path = PathBuf::from(&executable_path);
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !path.is_file() || !name.ends_with(".exe") || !(name.contains("dahua") || name.contains("smartplayer") || name.contains("smartpss") || name.contains("diskmanager")) {
        return Err("FCM will only launch a detected Dahua-compatible exporter.".to_string());
    }
    Command::new(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not launch Dahua exporter: {error}"))
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
fn launch_dahua_export_tool(_executable_path: String) -> Result<(), String> {
    Err("Dahua exporter launch is available in the Windows FCM Desktop application.".to_string())
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

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn image_dhfs_partition(_disk_number: u32, _partition_number: u32, _output_path: String) -> Result<DhfsImageReport, String> {
    Err("DHFS physical imaging is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn check_destination_free_space(_output_path: String, _required_bytes: u64) -> Result<DestinationSpaceReport, String> {
    Err("Destination free-space checks are available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn list_dhfs_partition_recordings(_disk_number: u32, _partition_number: u32) -> Result<Vec<PhysicalDhfsRecording>, String> {
    Err("Direct DHFS partition reading is available in the Windows FCM Desktop application.".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn extract_dhfs_recording_to_cache(_disk_number: u32, _partition_number: u32, _dhfs_partition_index: u32, _descriptor_index: u32, _cache_directory: String) -> Result<CachedClipReport, String> {
    Err("Direct DHFS recording extraction is available in the Windows FCM Desktop application.".to_string())
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![analyse_inserted_sd_card, cache_video_clip, clear_cached_clip, list_dhfs_partition_recordings, extract_dhfs_recording_to_cache, image_dhfs_partition, check_destination_free_space, convert_dhfs_image, detect_removable_disks, probe_partition_header, probe_indexed_cluster, scan_dhfs_metadata, inspect_dhfs_headers, inspect_dhfs_dpt, detect_dahua_export_tools, launch_dahua_export_tool, inspect_mounted_folder, inspect_sd_index])
        .run(tauri::generate_context!())
        .expect("error while running FCM SD Card Bridge");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nal_marker_helper_distinguishes_frame_boundaries() {
        assert!(starts_with_nal_marker(&[0, 0, 0, 1, 0x67]));
        assert!(starts_with_nal_marker(&[0, 0, 1, 0x67]));
        assert!(!starts_with_nal_marker(&[0xAA, 0xAA, 0xAA, 0xAA]));
    }

    fn write_le_u32(buffer: &mut [u8], offset: usize, value: u32) {
        buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_le_u64(buffer: &mut [u8], offset: usize, value: u64) {
        buffer[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    // Builds a minimal DHFS4.1 image with one two-fragment recording, matching the real on-disk layout confirmed against a physical card.
    fn build_synthetic_dhfs_image() -> Vec<u8> {
        const PARTITION_OFFSET: u64 = 40 * 512;
        const SUPERBLOCK_OFFSET: u64 = 2 * 512;
        const BLOCK_SIZE: u32 = 512;
        const FRAGMENT_SIZE_BLOCKS: u32 = 2;
        const DESCRIPTOR_OFFSET_BLOCKS: u32 = 4;
        const VIDEO_OFFSET_BLOCKS: u32 = 10;
        let fragment_size = FRAGMENT_SIZE_BLOCKS as u64 * BLOCK_SIZE as u64;
        let descriptor_offset = (PARTITION_OFFSET + DESCRIPTOR_OFFSET_BLOCKS as u64 * BLOCK_SIZE as u64) as usize;
        let video_offset = (PARTITION_OFFSET + VIDEO_OFFSET_BLOCKS as u64 * BLOCK_SIZE as u64) as usize;
        let mut buffer = vec![0_u8; video_offset + 2 * fragment_size as usize + 4096];
        buffer[0..7].copy_from_slice(b"DHFS4.1");

        let table_offset = 0x3c00_usize + 0x34;
        write_le_u32(&mut buffer, table_offset + 20, (SUPERBLOCK_OFFSET / 512) as u32);
        write_le_u64(&mut buffer, table_offset + 48, PARTITION_OFFSET / 512);
        buffer[table_offset + 64..table_offset + 68].copy_from_slice(&[0xaa, 0x55, 0xaa, 0x55]);

        let superblock = (PARTITION_OFFSET + SUPERBLOCK_OFFSET) as usize;
        write_le_u32(&mut buffer, superblock + 0x2c, BLOCK_SIZE);
        write_le_u32(&mut buffer, superblock + 0x30, FRAGMENT_SIZE_BLOCKS);
        write_le_u32(&mut buffer, superblock + 0x44, DESCRIPTOR_OFFSET_BLOCKS);
        write_le_u32(&mut buffer, superblock + 0x48, VIDEO_OFFSET_BLOCKS);
        write_le_u32(&mut buffer, superblock + 0x4c, 2);

        buffer[descriptor_offset] = 1;
        buffer[descriptor_offset + 1] = b'0';
        write_le_u32(&mut buffer, descriptor_offset + 4, 0x1000_0001);
        write_le_u32(&mut buffer, descriptor_offset + 8, 0x1000_0002);
        write_le_u32(&mut buffer, descriptor_offset + 12, 1);

        let descriptor1 = descriptor_offset + 32;
        buffer[descriptor1] = 2;
        write_le_u32(&mut buffer, descriptor1 + 12, 0);
        write_le_u32(&mut buffer, descriptor1 + 16, 1);

        buffer[video_offset..video_offset + 4].copy_from_slice(&[0, 0, 0, 1]);
        buffer[video_offset + 4..video_offset + fragment_size as usize].fill(0xAA);
        buffer[video_offset + fragment_size as usize..video_offset + fragment_size as usize + BLOCK_SIZE as usize].fill(0xBB);
        buffer
    }

    #[test]
    fn reconstructs_multi_fragment_recording_and_trims_final_fragment() {
        let image_dir = std::env::temp_dir().join(format!("fcm-dhfs-test-{}", std::process::id()));
        std::fs::create_dir_all(&image_dir).expect("create temp dir");
        let image_path = image_dir.join("synthetic.img");
        std::fs::write(&image_path, build_synthetic_dhfs_image()).expect("write synthetic image");

        let report = convert_dhfs_image(
            image_path.to_string_lossy().to_string(),
            image_dir.to_string_lossy().to_string(),
        ).expect("conversion should succeed against a well-formed synthetic image");

        assert_eq!(report.exported.len(), 1, "exactly one main recording should be reconstructed, not its chained fragment");
        let export = &report.exported[0];
        assert_eq!(export.bytes_written, 1024 + 512, "output must be the first fragment plus the trimmed final fragment, not the full reserved fragment size");
        assert!(export.starts_with_nal_marker, "the fragment offset math must land exactly on the encoded frame boundary");

        let output_bytes = std::fs::read(image_dir.join(&export.file_name)).expect("read reconstructed output");
        assert_eq!(output_bytes.len(), 1536);
        assert_eq!(&output_bytes[..4], &[0, 0, 0, 1]);
        assert!(output_bytes[4..1024].iter().all(|byte| *byte == 0xAA), "first fragment content must be preserved exactly");
        assert!(output_bytes[1024..].iter().all(|byte| *byte == 0xBB), "trimmed final fragment content must be preserved exactly, not padded with the full fragment size");

        std::fs::remove_dir_all(&image_dir).ok();
    }
}