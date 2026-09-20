//! Read-only reader for Dahua's proprietary DHFS4.1 recording volume.
//!
//! Dahua IPC/NVR SD cards do not carry a filesystem Windows can mount: the card is either raw
//! DHFS from sector 0, or an MBR/GPT partition whose contents are DHFS. Explorer shows nothing,
//! which is why operators call it "the hidden partition". This crate locates that volume on any
//! block source (a verified acquisition image or a raw `\\.\PhysicalDriveN` handle), walks the
//! partition table, superblock and fragment descriptors, lists the recordings and extracts them
//! byte-for-byte. Nothing here ever opens a source for writing.
//!
//! Layout references: gbatmobile/dhfs_extractor (MIT) for the DHFS4.1 partition table, superblock
//! and 32-byte descriptor layout; FFmpeg `libavformat/dhav.c` for the DHAV frame container that
//! newer firmware writes inside fragments; the V1 field bridge (`apps/sd-card-bridge`) for the two
//! behaviours proven on real cards: the partition table must be found through the `DHFS_DPT:`
//! marker rather than a fixed 0x3c00, and a card whose table is all zero keeps its superblock at
//! marker + 0x6c0.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8; 7] = b"DHFS4.1";
pub const DPT_MARKER: &[u8; 9] = b"DHFS_DPT:";
/// Partition-table entries start this far after the `DHFS_DPT:` marker and are 64 bytes each.
pub const DPT_ENTRIES_OFFSET: u64 = 0x34;
pub const DPT_ENTRY_SIZE: u64 = 64;
pub const DPT_TERMINATOR: [u8; 4] = [0xaa, 0x55, 0xaa, 0x55];
/// Verified on a real single-partition card: table entries all zero, real superblock here.
pub const SINGLE_PARTITION_SUPERBLOCK_OFFSET: u64 = 0x6c0;
pub const DESCRIPTOR_SIZE: u64 = 32;
pub const SECTOR: u64 = 512;
/// Windows raw device handles reject reads whose offset or length is not sector aligned.
pub const DEVICE_READ_ALIGNMENT: u64 = 4096;
/// How far into a source we look for a DHFS magic that is not at sector 0 or in a partition table.
pub const MAGIC_SCAN_LIMIT: u64 = 64 * 1024 * 1024;
const DPT_SCAN_BYTES: usize = 96 * 1024;
const PROBE_BYTES: usize = 256 * 1024;
const COPY_CHUNK: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DhfsError {
    Io(String),
    NotDhfs(String),
    Layout(String),
}

impl fmt::Display for DhfsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DhfsError::Io(detail) => write!(f, "Read failed: {detail}"),
            DhfsError::NotDhfs(detail) => write!(f, "No DHFS4.1 volume: {detail}"),
            DhfsError::Layout(detail) => write!(f, "DHFS layout problem: {detail}"),
        }
    }
}

impl std::error::Error for DhfsError {}

/// A random-access byte source. Implementations must never write.
pub trait BlockSource {
    /// Total size when known. Raw Windows devices do not report a length through `metadata()`.
    fn size_hint(&self) -> Option<u64>;
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), DhfsError>;
}

/// A file (image or raw device) read through sector-aligned windows.
pub struct AlignedFileSource {
    file: File,
    size: Option<u64>,
    alignment: u64,
}

impl AlignedFileSource {
    pub fn open_image(path: &Path) -> Result<Self, DhfsError> {
        let file = OpenOptions::new().read(true).write(false).open(path)
            .map_err(|error| DhfsError::Io(format!("could not open {} read-only: {error}", path.display())))?;
        let size = file.metadata().ok().map(|meta| meta.len()).filter(|len| *len > 0);
        Ok(Self { file, size, alignment: SECTOR })
    }

    /// Wrap an already-open read-only handle (e.g. `\\.\PhysicalDriveN`). `size` comes from the
    /// device inventory because the handle itself will not report one.
    pub fn from_file(file: File, size: Option<u64>, alignment: u64) -> Self {
        Self { file, size: size.filter(|len| *len > 0), alignment: alignment.max(1) }
    }
}

impl BlockSource for AlignedFileSource {
    fn size_hint(&self) -> Option<u64> { self.size }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), DhfsError> {
        if buf.is_empty() { return Ok(()); }
        let length = buf.len() as u64;
        if let Some(size) = self.size {
            if offset.saturating_add(length) > size {
                return Err(DhfsError::Io(format!("read of {length} bytes at {offset} runs past the end of the source ({size} bytes)")));
            }
        }
        let aligned_start = (offset / self.alignment) * self.alignment;
        let mut aligned_end = (offset + length).div_ceil(self.alignment) * self.alignment;
        if let Some(size) = self.size { aligned_end = aligned_end.min(size.max(offset + length)); }
        let aligned_len = (aligned_end - aligned_start) as usize;
        self.file.seek(SeekFrom::Start(aligned_start))
            .map_err(|error| DhfsError::Io(format!("seek to {aligned_start} failed: {error}")))?;
        let mut window = vec![0_u8; aligned_len];
        self.file.read_exact(&mut window)
            .map_err(|error| DhfsError::Io(format!("read of {aligned_len} bytes at {aligned_start} failed (requested {length} at {offset}): {error}")))?;
        let start_within = (offset - aligned_start) as usize;
        buf.copy_from_slice(&window[start_within..start_within + buf.len()]);
        Ok(())
    }
}

/// In-memory source, used by tests and by callers that already hold a small image.
pub struct MemorySource(pub Vec<u8>);

impl BlockSource for MemorySource {
    fn size_hint(&self) -> Option<u64> { Some(self.0.len() as u64) }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), DhfsError> {
        let end = offset.saturating_add(buf.len() as u64);
        if end > self.0.len() as u64 {
            return Err(DhfsError::Io(format!("read of {} bytes at {offset} runs past the end of the source ({} bytes)", buf.len(), self.0.len())));
        }
        buf.copy_from_slice(&self.0[offset as usize..end as usize]);
        Ok(())
    }
}

fn read_vec(source: &mut dyn BlockSource, offset: u64, length: usize) -> Result<Vec<u8>, DhfsError> {
    let mut buffer = vec![0_u8; length];
    source.read_at(offset, &mut buffer)?;
    Ok(buffer)
}

fn le_u32(bytes: &[u8]) -> u32 { u32::from_le_bytes(bytes[..4].try_into().expect("four bytes")) }
fn le_u64(bytes: &[u8]) -> u64 { u64::from_le_bytes(bytes[..8].try_into().expect("eight bytes")) }
fn le_u16(bytes: &[u8]) -> u16 { u16::from_le_bytes(bytes[..2].try_into().expect("two bytes")) }

// ---------------------------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------------------------

/// Dahua packs a civil date into 32 bits (year-2000:6, month:4, day:5, hour:5, minute:6, second:6).
/// The same layout is used by DHFS descriptors and by DHAV frame headers. Times are the camera's
/// own clock — there is no timezone in the data, so this is deliberately not a UTC instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DhfsTime {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl DhfsTime {
    pub fn decode(raw: u32) -> Self {
        Self {
            year: 2000 + ((raw >> 26) & 0x3f) as u16,
            month: ((raw >> 22) & 0x0f) as u8,
            day: ((raw >> 17) & 0x1f) as u8,
            hour: ((raw >> 12) & 0x1f) as u8,
            minute: ((raw >> 6) & 0x3f) as u8,
            second: (raw & 0x3f) as u8,
        }
    }

    pub fn encode(&self) -> u32 {
        (((self.year.saturating_sub(2000) as u32) & 0x3f) << 26)
            | ((self.month as u32 & 0x0f) << 22)
            | ((self.day as u32 & 0x1f) << 17)
            | ((self.hour as u32 & 0x1f) << 12)
            | ((self.minute as u32 & 0x3f) << 6)
            | (self.second as u32 & 0x3f)
    }

    pub fn is_plausible(&self) -> bool {
        (1..=12).contains(&self.month) && (1..=31).contains(&self.day) && self.hour < 24 && self.minute < 60 && self.second < 60
    }

    /// Seconds since 1970 treating the camera clock as if it were UTC (for durations/ordering only).
    pub fn naive_epoch_seconds(&self) -> i64 {
        let (y, m, d) = (self.year as i64, self.month as i64, self.day as i64);
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        days * 86_400 + self.hour as i64 * 3_600 + self.minute as i64 * 60 + self.second as i64
    }

    /// Filesystem-safe stamp, e.g. `2026-09-11_14-31-56`.
    pub fn file_stamp(&self) -> String {
        format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", self.year, self.month, self.day, self.hour, self.minute, self.second)
    }
}

impl fmt::Display for DhfsTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02} {:02}:{:02}:{:02}", self.year, self.month, self.day, self.hour, self.minute, self.second)
    }
}

// ---------------------------------------------------------------------------------------------
// Locating the volume
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum LocationMethod {
    /// `DHFS4.1` at sector 0: the whole device is the recording volume (no partition table).
    DeviceStart,
    /// An MBR partition entry points at the volume. Windows shows this partition as RAW.
    MbrPartition { index: u8, type_code: u8, first_lba: u32 },
    /// A GPT entry points at the volume.
    GptPartition { index: u32, first_lba: u64 },
    /// Found by scanning sector boundaries inside the first `MAGIC_SCAN_LIMIT` bytes.
    Scan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeLocation {
    /// Absolute offset of the `DHFS4.1` magic in the source.
    pub base_offset: u64,
    #[serde(flatten)]
    pub method: LocationMethod,
}

fn magic_at(source: &mut dyn BlockSource, offset: u64) -> bool {
    let mut bytes = [0_u8; 7];
    source.read_at(offset, &mut bytes).is_ok() && &bytes == MAGIC
}

/// Find where the DHFS volume starts. Checks sector 0, then MBR/GPT partition starts, then scans.
pub fn locate_volume(source: &mut dyn BlockSource) -> Result<VolumeLocation, DhfsError> {
    let sector0 = read_vec(source, 0, SECTOR as usize)?;
    if sector0.starts_with(MAGIC) {
        return Ok(VolumeLocation { base_offset: 0, method: LocationMethod::DeviceStart });
    }
    let mut notes = Vec::new();
    if sector0[510] == 0x55 && sector0[511] == 0xaa {
        let entries: Vec<(u8, u8, u32)> = (0..4).map(|index| {
            let entry = &sector0[446 + index * 16..446 + index * 16 + 16];
            (index as u8, entry[4], le_u32(&entry[8..12]))
        }).collect();
        if entries.iter().any(|(_, type_code, _)| *type_code == 0xee) {
            match locate_in_gpt(source) {
                Ok(Some(location)) => return Ok(location),
                Ok(None) => notes.push("GPT present but no partition starts with DHFS4.1".to_string()),
                Err(error) => notes.push(format!("GPT unreadable: {error}")),
            }
        }
        for (index, type_code, first_lba) in entries {
            if first_lba == 0 || type_code == 0 { continue; }
            let offset = first_lba as u64 * SECTOR;
            if magic_at(source, offset) {
                return Ok(VolumeLocation { base_offset: offset, method: LocationMethod::MbrPartition { index, type_code, first_lba } });
            }
            notes.push(format!("MBR partition {index} (type 0x{type_code:02x}, LBA {first_lba}) is not DHFS"));
        }
    } else {
        notes.push("no MBR signature at sector 0".to_string());
    }
    let limit = source.size_hint().map(|size| size.min(MAGIC_SCAN_LIMIT)).unwrap_or(MAGIC_SCAN_LIMIT);
    let mut offset = SECTOR;
    while offset + SECTOR <= limit {
        let chunk_len = (limit - offset).min(COPY_CHUNK) as usize;
        let chunk = match read_vec(source, offset, chunk_len) {
            Ok(chunk) => chunk,
            Err(_) => break,
        };
        let mut position = 0;
        while position + MAGIC.len() <= chunk.len() {
            if &chunk[position..position + MAGIC.len()] == MAGIC {
                return Ok(VolumeLocation { base_offset: offset + position as u64, method: LocationMethod::Scan });
            }
            position += SECTOR as usize;
        }
        offset += chunk_len as u64;
    }
    notes.push(format!("no DHFS4.1 magic on a sector boundary within the first {} MiB", limit / (1024 * 1024)));
    Err(DhfsError::NotDhfs(notes.join("; ")))
}

fn locate_in_gpt(source: &mut dyn BlockSource) -> Result<Option<VolumeLocation>, DhfsError> {
    let header = read_vec(source, SECTOR, SECTOR as usize)?;
    if &header[..8] != b"EFI PART" { return Err(DhfsError::Layout("protective MBR without a GPT header".to_string())); }
    let entries_lba = le_u64(&header[72..80]);
    let entry_count = le_u32(&header[80..84]).min(128);
    let entry_size = le_u32(&header[84..88]) as u64;
    if entry_size < 128 || entries_lba == 0 { return Err(DhfsError::Layout("GPT header has an invalid entry table".to_string())); }
    for index in 0..entry_count {
        let entry = read_vec(source, entries_lba * SECTOR + index as u64 * entry_size, 128)?;
        if entry[..16].iter().all(|byte| *byte == 0) { continue; }
        let first_lba = le_u64(&entry[32..40]);
        if first_lba == 0 { continue; }
        if magic_at(source, first_lba * SECTOR) {
            return Ok(Some(VolumeLocation { base_offset: first_lba * SECTOR, method: LocationMethod::GptPartition { index, first_lba } }));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------------------------
// Partition table + superblock
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    pub index: u32,
    /// Offset of this DHFS partition relative to the volume base.
    pub partition_offset: u64,
    /// Offset of the superblock relative to the partition.
    pub superblock_offset: u64,
    pub block_size: u32,
    pub fragment_blocks: u32,
    pub descriptor_count: u32,
    pub descriptor_offset_blocks: u32,
    pub video_offset_blocks: u32,
    pub first_date: Option<DhfsTime>,
    pub last_date: Option<DhfsTime>,
    /// Absolute source offsets, resolved once so every later read is plain arithmetic.
    pub superblock_absolute: u64,
    pub descriptor_table_absolute: u64,
    pub video_absolute: u64,
    pub fragment_size: u64,
    /// Bytes this partition's fragment area spans (descriptor_count * fragment_size).
    pub capacity_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub location: VolumeLocation,
    pub dpt_marker_offset: u64,
    pub partitions: Vec<Partition>,
    /// Why the partition walk stopped — surfaced so an unusual card is explainable, not silent.
    pub table_note: String,
}

fn read_partition(source: &mut dyn BlockSource, index: u32, base: u64, partition_offset: u64, superblock_offset: u64) -> Result<Partition, DhfsError> {
    let superblock_absolute = base + partition_offset + superblock_offset;
    let superblock = read_vec(source, superblock_absolute, 0x50)?;
    let block_size = le_u32(&superblock[0x2c..0x30]);
    let fragment_blocks = le_u32(&superblock[0x30..0x34]);
    let descriptor_offset_blocks = le_u32(&superblock[0x44..0x48]);
    let video_offset_blocks = le_u32(&superblock[0x48..0x4c]);
    let descriptor_count = le_u32(&superblock[0x4c..0x50]);
    let plausible = |raw: u32| { let time = DhfsTime::decode(raw); (raw != 0 && time.is_plausible()).then_some(time) };
    let first_date = plausible(le_u32(&superblock[0x10..0x14]));
    let last_date = plausible(le_u32(&superblock[0x14..0x18]));
    let fragment_size = fragment_blocks as u64 * block_size as u64;
    Ok(Partition {
        index,
        partition_offset,
        superblock_offset,
        block_size,
        fragment_blocks,
        descriptor_count,
        descriptor_offset_blocks,
        video_offset_blocks,
        first_date,
        last_date,
        superblock_absolute,
        descriptor_table_absolute: base + partition_offset + descriptor_offset_blocks as u64 * block_size as u64,
        video_absolute: base + partition_offset + video_offset_blocks as u64 * block_size as u64,
        fragment_size,
        capacity_bytes: descriptor_count as u64 * fragment_size,
    })
}

fn partition_is_sane(partition: &Partition) -> bool {
    partition.block_size >= 512
        && partition.block_size.is_power_of_two()
        && partition.fragment_blocks > 0
        && partition.descriptor_count > 0
        && partition.descriptor_count < 50_000_000
        && partition.video_offset_blocks >= partition.descriptor_offset_blocks
}

/// Parse the partition table and superblocks of a located volume.
pub fn read_volume(source: &mut dyn BlockSource, location: VolumeLocation) -> Result<Volume, DhfsError> {
    let base = location.base_offset;
    if !magic_at(source, base) {
        return Err(DhfsError::NotDhfs(format!("no DHFS4.1 magic at offset {base}")));
    }
    let scan = read_vec(source, base, DPT_SCAN_BYTES)?;
    let marker_within = scan.windows(DPT_MARKER.len()).position(|window| window == DPT_MARKER)
        .ok_or_else(|| DhfsError::Layout("no DHFS_DPT: partition-table marker within the first 96 KiB of the volume".to_string()))?;
    let dpt_marker_offset = base + marker_within as u64;
    let mut entry_offset = dpt_marker_offset + DPT_ENTRIES_OFFSET;
    let mut partitions = Vec::new();
    let mut table_note = "Reached the 64-entry scan limit.".to_string();
    for _ in 0..64 {
        let entry = read_vec(source, entry_offset, DPT_ENTRY_SIZE as usize)?;
        if entry[..4] == DPT_TERMINATOR { table_note = "Table ended at the 0xaa55aa55 terminator.".to_string(); break; }
        let superblock_offset = le_u32(&entry[20..24]) as u64 * SECTOR;
        let partition_offset = le_u64(&entry[48..56]) * SECTOR;
        if partition_offset == 0 { table_note = "Table entry had a zero partition offset.".to_string(); break; }
        let partition = read_partition(source, partitions.len() as u32, base, partition_offset, superblock_offset)?;
        if !partition_is_sane(&partition) {
            table_note = format!("Table entry {} pointed at an implausible superblock (block size {}, {} descriptors).", partitions.len(), partition.block_size, partition.descriptor_count);
            break;
        }
        partitions.push(partition);
        entry_offset += DPT_ENTRY_SIZE;
    }
    if partitions.is_empty() {
        let fallback_offset = dpt_marker_offset - base + SINGLE_PARTITION_SUPERBLOCK_OFFSET;
        let partition = read_partition(source, 0, base, 0, fallback_offset)?;
        if !partition_is_sane(&partition) {
            return Err(DhfsError::Layout(format!(
                "{table_note} The single-partition superblock at marker + 0x{SINGLE_PARTITION_SUPERBLOCK_OFFSET:x} is also implausible (block size {}, {} descriptors).",
                partition.block_size, partition.descriptor_count
            )));
        }
        table_note = format!("{table_note} Fell back to the single-partition superblock at marker + 0x{SINGLE_PARTITION_SUPERBLOCK_OFFSET:x}.");
        partitions.push(partition);
    }
    Ok(Volume { location, dpt_marker_offset, partitions, table_note })
}

/// Locate and parse in one step.
pub fn open_volume(source: &mut dyn BlockSource) -> Result<Volume, DhfsError> {
    let location = locate_volume(source)?;
    read_volume(source, location)
}

// ---------------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub partition_index: u32,
    /// Index of the recording's first (main) descriptor — the stable handle for extraction.
    pub descriptor: u32,
    pub channel: u32,
    pub start: DhfsTime,
    pub end: DhfsTime,
    pub duration_seconds: i64,
    pub fragment_count: u32,
    pub bytes: u64,
    /// Fragment indices in stream order.
    pub fragments: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub volume: Volume,
    pub recordings: Vec<Recording>,
    /// Main descriptors that were present but could not be trusted (zero length, broken chain...).
    pub skipped_descriptors: u32,
    pub warnings: Vec<String>,
}

struct Descriptor<'a>(&'a [u8]);

impl Descriptor<'_> {
    fn kind(&self) -> u8 { self.0[0] }
    fn channel(&self) -> u32 { self.0[1].saturating_sub(b'0') as u32 + 1 }
    fn begin(&self) -> u32 { le_u32(&self.0[4..8]) }
    fn end(&self) -> u32 { le_u32(&self.0[8..12]) }
    fn next(&self) -> u32 { le_u32(&self.0[12..16]) }
    fn last_fragment_blocks(&self) -> u32 { le_u32(&self.0[16..20]) }
}

fn read_descriptor_table(source: &mut dyn BlockSource, partition: &Partition) -> Result<Vec<u8>, DhfsError> {
    let total = partition.descriptor_count as u64 * DESCRIPTOR_SIZE;
    let mut table = Vec::with_capacity(total as usize);
    let mut copied = 0_u64;
    while copied < total {
        let length = (total - copied).min(COPY_CHUNK) as usize;
        table.extend_from_slice(&read_vec(source, partition.descriptor_table_absolute + copied, length)?);
        copied += length as u64;
    }
    Ok(table)
}

fn follow_chain(table: &[u8], descriptor_count: u32, start: u32) -> Result<Vec<u32>, String> {
    let mut chain = Vec::new();
    let mut current = start;
    loop {
        if current == u32::MAX || current >= descriptor_count { break; }
        if chain.contains(&current) { return Err(format!("descriptor {start}: fragment chain is cyclic at {current}")); }
        chain.push(current);
        if chain.len() > descriptor_count as usize { return Err(format!("descriptor {start}: fragment chain is longer than the table")); }
        let next = Descriptor(&table[current as usize * 32..current as usize * 32 + 32]).next();
        if next == 0 { break; }
        current = next;
    }
    if chain.is_empty() { return Err(format!("descriptor {start}: recording has no fragments")); }
    Ok(chain)
}

fn recording_from_descriptor(table: &[u8], partition: &Partition, index: u32) -> Result<Option<Recording>, String> {
    let descriptor = Descriptor(&table[index as usize * 32..index as usize * 32 + 32]);
    if descriptor.kind() != 1 { return Ok(None); }
    let (begin_raw, end_raw) = (descriptor.begin(), descriptor.end());
    if begin_raw == end_raw { return Err(format!("descriptor {index}: zero-length recording")); }
    let chain = follow_chain(table, partition.descriptor_count, index)?;
    let last = Descriptor(&table[*chain.last().expect("non-empty chain") as usize * 32..*chain.last().expect("non-empty chain") as usize * 32 + 32]);
    let last_size = last.last_fragment_blocks() as u64 * partition.block_size as u64;
    if last_size == 0 || last_size > partition.fragment_size {
        return Err(format!("descriptor {index}: final fragment size {last_size} is outside 1..={}", partition.fragment_size));
    }
    let start = DhfsTime::decode(begin_raw);
    let end = DhfsTime::decode(end_raw);
    Ok(Some(Recording {
        partition_index: partition.index,
        descriptor: index,
        channel: descriptor.channel(),
        start,
        end,
        duration_seconds: end.naive_epoch_seconds() - start.naive_epoch_seconds(),
        fragment_count: chain.len() as u32,
        bytes: (chain.len() as u64 - 1) * partition.fragment_size + last_size,
        fragments: chain,
    }))
}

/// List every trustworthy recording on the volume, oldest first.
pub fn list_recordings(source: &mut dyn BlockSource, volume: &Volume) -> Result<Catalog, DhfsError> {
    let mut recordings = Vec::new();
    let mut skipped = 0_u32;
    let mut warnings = Vec::new();
    for partition in &volume.partitions {
        let table = read_descriptor_table(source, partition)?;
        for index in 0..partition.descriptor_count {
            match recording_from_descriptor(&table, partition, index) {
                Ok(Some(recording)) => recordings.push(recording),
                Ok(None) => {}
                Err(reason) => {
                    skipped += 1;
                    if warnings.len() < 50 { warnings.push(format!("partition {}: {reason}", partition.index)); }
                }
            }
        }
    }
    recordings.sort_by(|a, b| a.start.cmp(&b.start).then(a.channel.cmp(&b.channel)).then(a.descriptor.cmp(&b.descriptor)));
    Ok(Catalog { volume: volume.clone(), recordings, skipped_descriptors: skipped, warnings })
}

/// Locate, parse and list in one step.
pub fn catalog(source: &mut dyn BlockSource) -> Result<Catalog, DhfsError> {
    let volume = open_volume(source)?;
    list_recordings(source, &volume)
}

// ---------------------------------------------------------------------------------------------
// Stream probing (what is actually inside a fragment)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DhavFrame {
    pub frame_type: u8,
    pub subtype: u8,
    pub channel: u8,
    pub frame_number: u32,
    pub frame_length: u32,
    pub date: DhfsTime,
    pub timestamp_ms: u16,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<u8>,
    /// True when the `dhav` trailer sits exactly where `frame_length` says it should.
    pub trailer_verified: bool,
}

/// Parse one DHAV frame header at the start of `bytes` (FFmpeg `dhav.c` field order).
pub fn dhav_frame_header(bytes: &[u8]) -> Option<DhavFrame> {
    if bytes.len() < 24 || &bytes[..4] != b"DHAV" { return None; }
    let frame_type = bytes[4];
    let frame_length = le_u32(&bytes[12..16]);
    if frame_length < 24 { return None; }
    let mut frame = DhavFrame {
        frame_type,
        subtype: bytes[5],
        channel: bytes[6],
        frame_number: le_u32(&bytes[8..12]),
        frame_length,
        date: DhfsTime::decode(le_u32(&bytes[16..20])),
        timestamp_ms: le_u16(&bytes[20..22]),
        video_codec: None,
        width: None,
        height: None,
        frame_rate: None,
        trailer_verified: false,
    };
    if frame_type != 0xf1 {
        let mut ext_remaining = bytes[22] as i32;
        let mut cursor = 24_usize;
        while ext_remaining > 0 && cursor < bytes.len() {
            let kind = bytes[cursor];
            let consumed: usize = match kind {
                // Real frame (2026-09-19): `80 00 f0 87` = 1920x1080; one skipped byte, then width/8, height/8.
                0x80 => {
                    if cursor + 4 > bytes.len() { break; }
                    frame.width = Some(8 * bytes[cursor + 2] as u32);
                    frame.height = Some(8 * bytes[cursor + 3] as u32);
                    4
                }
                0x81 => {
                    if cursor + 4 > bytes.len() { break; }
                    frame.video_codec = Some(dhav_codec_name(bytes[cursor + 2]).to_string());
                    frame.frame_rate = Some(bytes[cursor + 3]);
                    4
                }
                0x82 => {
                    if cursor + 8 > bytes.len() { break; }
                    frame.width = Some(le_u16(&bytes[cursor + 4..cursor + 6]) as u32);
                    frame.height = Some(le_u16(&bytes[cursor + 6..cursor + 8]) as u32);
                    8
                }
                0x83 => 4,
                0x88 | 0x8c | 0x91 | 0x92 | 0x93 | 0x95 | 0x9a | 0x9b | 0xb3 => 8,
                0x84 | 0x85 | 0x8b | 0x94 | 0x96 | 0xa0 | 0xb2 | 0xb4 => {
                    if cursor + 2 > bytes.len() { break; }
                    bytes[cursor + 1] as usize + 2
                }
                _ => break,
            };
            cursor += consumed;
            ext_remaining -= consumed as i32;
        }
        // No codec extension (or one this parser does not know): the payload's first parameter set still says.
        if frame.video_codec.is_none() && frame_kind_is_video(frame_type) {
            let payload_at = 24 + bytes[22] as usize;
            if let Some(is_hevc) = nal_parameter_set_at(bytes, payload_at) { frame.video_codec = Some(if is_hevc { "hevc" } else { "h264" }.to_string()); }
        }
    }
    let trailer_at = frame_length as usize - 8;
    if trailer_at + 8 <= bytes.len() {
        frame.trailer_verified = &bytes[trailer_at..trailer_at + 4] == b"dhav" && le_u32(&bytes[trailer_at + 4..trailer_at + 8]) == frame_length;
    }
    Some(frame)
}

fn dhav_codec_name(code: u8) -> &'static str {
    match code {
        0x01 => "mpeg4",
        0x03 => "mjpeg",
        0x02 | 0x04 | 0x08 => "h264",
        0x0c => "hevc",
        _ => "unknown",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamKind {
    /// Dahua's own frame container. FFmpeg demuxes it natively (`ffmpeg -i clip.dav -c copy`).
    Dhav { first_frame: DhavFrame },
    /// Raw H.264 Annex-B elementary stream starting at an SPS.
    ElementaryH264,
    /// Raw H.265 Annex-B elementary stream starting at a VPS/SPS.
    ElementaryH265,
    /// Bytes preserved verbatim; no recognised stream start.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    #[serde(flatten)]
    pub stream: StreamKind,
    /// Bytes of proprietary per-recording header (`DHII` stream configuration) before the stream.
    pub stream_start: u64,
    pub has_dhii_header: bool,
    pub extension: String,
    pub content_type: String,
}

fn nal_parameter_set_at(bytes: &[u8], index: usize) -> Option<bool> {
    let four = bytes.get(index..index + 4)? == [0, 0, 0, 1];
    let three = !four && bytes.get(index..index + 3)? == [0, 0, 1];
    if !four && !three { return None; }
    let header = *bytes.get(index + if four { 4 } else { 3 })?;
    let hevc_type = (header >> 1) & 0x3f;
    if header & 0x80 == 0 && (hevc_type == 32 || hevc_type == 33) { return Some(true); }
    if header & 0x1f == 7 && header & 0x80 == 0 { return Some(false); }
    None
}

/// Work out what the first bytes of a recording contain and where the real stream starts.
pub fn probe_stream(first_bytes: &[u8]) -> StreamProbe {
    let has_dhii_header = first_bytes.starts_with(b"DHII");
    let mut index = 0_usize;
    while index + 24 <= first_bytes.len() {
        if &first_bytes[index..index + 4] == b"DHAV" {
            if let Some(frame) = dhav_frame_header(&first_bytes[index..]) {
                let inside_buffer = index + frame.frame_length as usize <= first_bytes.len();
                if frame.trailer_verified || !inside_buffer {
                    return StreamProbe {
                        stream: StreamKind::Dhav { first_frame: frame },
                        stream_start: index as u64,
                        has_dhii_header,
                        extension: "dav".to_string(),
                        content_type: "video/x-dahua-dav".to_string(),
                    };
                }
            }
        }
        if let Some(is_hevc) = nal_parameter_set_at(first_bytes, index) {
            return StreamProbe {
                stream: if is_hevc { StreamKind::ElementaryH265 } else { StreamKind::ElementaryH264 },
                stream_start: index as u64,
                has_dhii_header,
                extension: if is_hevc { "h265" } else { "h264" }.to_string(),
                content_type: if is_hevc { "video/h265" } else { "video/h264" }.to_string(),
            };
        }
        index += 1;
    }
    StreamProbe { stream: StreamKind::Unknown, stream_start: 0, has_dhii_header, extension: "dhfs".to_string(), content_type: "application/octet-stream".to_string() }
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub bytes_written: u64,
    pub sha256: String,
    pub probe: StreamProbe,
    pub fragments_copied: u32,
    pub kind: ContentKind,
    pub stats: ExtractionStats,
}

/// What a recording turned out to hold once its bytes were read frame by frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    /// DHAV-framed video: the frames were validated one by one and copied verbatim.
    DhavVideo,
    /// Back-to-back JPEG stills (Dahua's picture stream), one file per picture.
    Pictures,
    /// No DHAV frames dated inside the recording: bytes copied as they lay, header trimmed (older firmware).
    RawStream,
}

/// Counts that make an extraction explainable: how much of the card region was the recording, how much
/// was the filesystem's own bookkeeping or a previous occupant's leftovers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionStats {
    pub frames_kept: u32,
    pub video_frames: u32,
    pub key_frames: u32,
    pub audio_frames: u32,
    /// Frames whose own clock lies outside the recording: a previous occupant of the flash, never erased.
    pub stale_frames: u32,
    pub stale_bytes: u64,
    /// Bytes that were neither a frame nor a picture (index area, padding, erased space).
    pub unstructured_bytes: u64,
    /// Group checkpoint blocks (4 KiB, mostly zeros) the filesystem writes mid-frame, removed so decoders see whole frames.
    pub structural_bytes_removed: u64,
    /// In-window P/audio frames before the first key frame: undecodable on their own, so not written.
    pub leading_frames_dropped: u32,
    pub source_bytes_read: u64,
    pub pictures: u32,
    /// First and last kept frame / picture, on the camera's clock.
    pub content_start: Option<DhfsTime>,
    pub content_end: Option<DhfsTime>,
    /// True when scanning stopped because the next frame already belonged to a later recording.
    pub stopped_at_next_recording: bool,
    /// True when the last frame ran past the end of the recording's fragments.
    pub truncated_final_frame: bool,
}

/// Recordings begin a little before their descriptor time (pre-record) and may run a little past it.
const WINDOW_BEFORE_SECONDS: i64 = 90;
const WINDOW_AFTER_SECONDS: i64 = 15;
/// A frame header claiming more than this is corruption, not a frame.
const MAX_FRAME_BYTES: u32 = 32 << 20;
/// Once frames have been kept, this much continuous 0xFF (erased flash) ends the recording.
const ERASED_RUN_BYTES: usize = 64 * 1024;
const SCAN_COMPACT_BYTES: usize = 8 << 20;
/// Every fragment is written in groups of this many blocks; the group's last block is a write checkpoint
/// (below), not stream data. Measured on a real card: block 4096 -> 2 MiB groups.
const CHECKPOINT_GROUP_BLOCKS: u64 = 512;
/// Bytes 4..8 of a group checkpoint block: CRC, this magic, a counter, the recording's begin time, the time of
/// the last write, and the descriptor index, then zeros. Frames straddling the block continue after it.
const CHECKPOINT_MAGIC: [u8; 4] = [0x13, 0x57, 0x75, 0x31];

fn is_checkpoint_block(block: &[u8]) -> bool {
    block.len() >= 8 && (block[4..8] == CHECKPOINT_MAGIC || block.iter().all(|byte| *byte == 0))
}

fn frame_kind_is_video(kind: u8) -> bool { matches!(kind, 0xfc | 0xfd) }
fn frame_kind_is_audio(kind: u8) -> bool { matches!(kind, 0xf0 | 0xf1) }
fn frame_kind_is_known(kind: u8) -> bool { frame_kind_is_video(kind) || frame_kind_is_audio(kind) }

/// Everything a recording's descriptor chain covers, in stream order, read a chunk at a time with the
/// filesystem's group checkpoint blocks removed. The last fragment is read in full: the descriptor's
/// "blocks used" field has been seen under-reporting while frames continued, so the frame walk decides
/// where the recording really ends.
struct RecordingBytes<'a> {
    source: &'a mut dyn BlockSource,
    fragments: Vec<u64>,
    fragment_size: u64,
    block_size: u64,
    /// Bytes the descriptor claims for the last fragment; reads past it that fail (image ends there) end the stream.
    declared_last_len: u64,
    fragment_index: usize,
    offset_in_fragment: u64,
    structural_removed: u64,
    bytes_read: u64,
}

impl<'a> RecordingBytes<'a> {
    fn new(source: &'a mut dyn BlockSource, partition: &Partition, recording: &Recording) -> Self {
        let fragments: Vec<u64> = recording.fragments.iter().map(|fragment| partition.video_absolute + *fragment as u64 * partition.fragment_size).collect();
        let declared_last_len = recording.bytes.saturating_sub((fragments.len() as u64 - 1) * partition.fragment_size).min(partition.fragment_size);
        Self { source, fragments, fragment_size: partition.fragment_size, block_size: partition.block_size as u64, declared_last_len, fragment_index: 0, offset_in_fragment: 0, structural_removed: 0, bytes_read: 0 }
    }

    fn read(&mut self, offset: u64, length: usize) -> Result<Option<Vec<u8>>, DhfsError> {
        let base = self.fragments[self.fragment_index];
        match read_vec(self.source, base + offset, length) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(_) if self.fragment_index + 1 == self.fragments.len() && offset >= self.declared_last_len => Ok(None),
            Err(error) => Err(DhfsError::Io(format!("card read failed inside fragment {}; partial output retained: {error}", self.fragment_index))),
        }
    }

    /// Append the next chunk of recording bytes to `out`; false once every fragment has been read.
    fn fill(&mut self, out: &mut Vec<u8>) -> Result<bool, DhfsError> {
        loop {
            if self.fragment_index >= self.fragments.len() { return Ok(false); }
            if self.offset_in_fragment >= self.fragment_size { self.fragment_index += 1; self.offset_in_fragment = 0; continue; }
            let group = CHECKPOINT_GROUP_BLOCKS * self.block_size;
            let checkpoint_at = group - self.block_size;
            let in_group = self.offset_in_fragment % group;
            if in_group == checkpoint_at {
                let Some(block) = self.read(self.offset_in_fragment, self.block_size as usize)? else { self.fragment_index = self.fragments.len(); return Ok(false); };
                self.bytes_read += self.block_size;
                self.offset_in_fragment += self.block_size;
                if is_checkpoint_block(&block) { self.structural_removed += self.block_size; continue; }
                out.extend_from_slice(&block);
                return Ok(true);
            }
            let until_checkpoint = if in_group < checkpoint_at { checkpoint_at - in_group } else { group - in_group };
            let length = until_checkpoint.min(COPY_CHUNK).min(self.fragment_size - self.offset_in_fragment) as usize;
            let Some(chunk) = self.read(self.offset_in_fragment, length)? else { self.fragment_index = self.fragments.len(); return Ok(false); };
            out.extend_from_slice(&chunk);
            self.bytes_read += length as u64;
            self.offset_in_fragment += length as u64;
            return Ok(true);
        }
    }
}

struct FrameHeader { kind: u8, length: usize, date: DhfsTime }

fn parse_frame_header(bytes: &[u8]) -> Option<FrameHeader> {
    if bytes.len() < 24 || &bytes[..4] != b"DHAV" { return None; }
    let kind = bytes[4];
    if !frame_kind_is_known(kind) { return None; }
    let length = le_u32(&bytes[12..16]);
    if length < 32 || length > MAX_FRAME_BYTES { return None; }
    Some(FrameHeader { kind, length: length as usize, date: DhfsTime::decode(le_u32(&bytes[16..20])) })
}

fn trailer_matches(frame: &[u8]) -> bool {
    let n = frame.len();
    n >= 32 && &frame[n - 8..n - 4] == b"dhav" && le_u32(&frame[n - 4..]) as usize == n
}

/// Frame counts and clock span of an `-r2` DHAV file already on disk, read header by header (the frames
/// were validated and written back to back). Stops at the first byte that is not a frame header.
pub fn summarize_dhav_file(path: &Path) -> Result<ExtractionStats, DhfsError> {
    let mut file = File::open(path).map_err(|error| DhfsError::Io(format!("could not open {}: {error}", path.display())))?;
    let len = file.metadata().map_err(|error| DhfsError::Io(error.to_string()))?.len();
    let mut stats = ExtractionStats::default();
    let mut header = [0_u8; 24];
    let mut pos = 0_u64;
    while pos + 24 <= len {
        file.seek(SeekFrom::Start(pos)).map_err(|error| DhfsError::Io(error.to_string()))?;
        file.read_exact(&mut header).map_err(|error| DhfsError::Io(error.to_string()))?;
        let Some(frame) = parse_frame_header(&header) else { break; };
        if pos + frame.length as u64 > len { stats.truncated_final_frame = true; break; }
        stats.frames_kept += 1;
        if frame_kind_is_video(frame.kind) { stats.video_frames += 1; }
        if frame.kind == 0xfd { stats.key_frames += 1; }
        if frame_kind_is_audio(frame.kind) { stats.audio_frames += 1; }
        if stats.content_start.is_none() { stats.content_start = Some(frame.date); }
        stats.content_end = Some(frame.date);
        pos += frame.length as u64;
    }
    Ok(stats)
}

fn window_for(recording: &Recording) -> (i64, i64) {
    let begin = recording.start.naive_epoch_seconds();
    let end = recording.end.naive_epoch_seconds().max(begin);
    (begin - WINDOW_BEFORE_SECONDS, end + WINDOW_AFTER_SECONDS)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> { haystack.windows(needle.len()).position(|window| window == needle) }

/// Walk the recording's bytes as DHAV frames: validate each header against its trailer, keep only frames
/// the camera dated inside this recording, start at the first key frame, stop at erased flash or at the
/// next recording. Writes nothing when no frame qualifies, so the caller can fall back. With `head_frames`
/// the walk stops once that many video frames have been written (or `HEAD_MAX_BYTES`): enough to decode a
/// picture, read from a fraction of the recording.
fn extract_dhav_frames(source: &mut dyn BlockSource, partition: &Partition, recording: &Recording, sink: &mut HashingSink<'_>, head_frames: Option<u32>) -> Result<Option<(StreamProbe, ExtractionStats)>, DhfsError> {
    let (window_begin, window_end) = window_for(recording);
    let mut reader = RecordingBytes::new(source, partition, recording);
    let mut buf: Vec<u8> = Vec::with_capacity(2 * COPY_CHUNK as usize);
    let mut pos = 0_usize;
    let mut eof = false;
    let mut stats = ExtractionStats::default();
    let mut probe: Option<StreamProbe> = None;
    let mut erased_run = 0_usize;
    loop {
        if pos > SCAN_COMPACT_BYTES { buf.drain(..pos); pos = 0; }
        if buf.len() - pos < 24 {
            if eof { stats.unstructured_bytes += (buf.len() - pos) as u64; break; }
            if !reader.fill(&mut buf)? { eof = true; }
            continue;
        }
        let Some(rel) = find(&buf[pos..], b"DHAV") else {
            let span = &buf[pos..];
            if probe.is_some() && span.iter().all(|byte| *byte == 0xff) {
                erased_run += span.len();
                if erased_run >= ERASED_RUN_BYTES { break; }
            } else { erased_run = 0; }
            let keep = 3.min(span.len());
            stats.unstructured_bytes += (span.len() - keep) as u64;
            pos = buf.len() - keep;
            if eof { stats.unstructured_bytes += keep as u64; break; }
            if !reader.fill(&mut buf)? { eof = true; }
            continue;
        };
        erased_run = 0;
        stats.unstructured_bytes += rel as u64;
        pos += rel;
        if buf.len() - pos < 24 { if eof { stats.unstructured_bytes += (buf.len() - pos) as u64; break; } if !reader.fill(&mut buf)? { eof = true; } continue; }
        let Some(header) = parse_frame_header(&buf[pos..pos + 24]) else { stats.unstructured_bytes += 4; pos += 4; continue; };
        if buf.len() - pos < header.length {
            if eof {
                // The card ended (or a later occupant began) inside this frame.
                if probe.is_some() { stats.truncated_final_frame = true; }
                stats.unstructured_bytes += (buf.len() - pos) as u64;
                break;
            }
            if !reader.fill(&mut buf)? { eof = true; }
            continue;
        }
        let frame = &buf[pos..pos + header.length];
        if !trailer_matches(frame) { stats.unstructured_bytes += 4; pos += 4; continue; }
        let at = header.date.naive_epoch_seconds();
        if at < window_begin || at > window_end {
            if probe.is_some() && at > window_end { stats.stopped_at_next_recording = true; break; }
            stats.stale_frames += 1;
            stats.stale_bytes += header.length as u64;
            pos += header.length;
            continue;
        }
        if probe.is_none() && header.kind != 0xfd {
            stats.leading_frames_dropped += 1;
            pos += header.length;
            continue;
        }
        if probe.is_none() {
            probe = Some(probe_stream(&frame[..frame.len().min(PROBE_BYTES)]));
            stats.content_start = Some(header.date);
        }
        sink.write_all(frame)?;
        stats.frames_kept += 1;
        if frame_kind_is_video(header.kind) { stats.video_frames += 1; }
        if header.kind == 0xfd { stats.key_frames += 1; }
        if frame_kind_is_audio(header.kind) { stats.audio_frames += 1; }
        stats.content_end = Some(header.date);
        pos += header.length;
        if let Some(limit) = head_frames { if stats.video_frames >= limit || sink.written >= HEAD_MAX_BYTES { break; } }
    }
    stats.structural_bytes_removed = reader.structural_removed;
    stats.source_bytes_read = reader.bytes_read;
    Ok(probe.map(|probe| (probe, stats)))
}

/// Copy a recording's fragments as they lie, trimming the proprietary `DHII` header: the path for cards whose
/// firmware writes raw elementary streams rather than DHAV frames.
fn extract_raw_stream(source: &mut dyn BlockSource, volume: &Volume, recording: &Recording, sink: &mut HashingSink<'_>) -> Result<ExtractReport, DhfsError> {
    let partition = volume.partitions.iter().find(|partition| partition.index == recording.partition_index)
        .ok_or_else(|| DhfsError::Layout(format!("partition {} is not part of this volume", recording.partition_index)))?;
    let mut probe = None;
    for (position, fragment) in recording.fragments.iter().enumerate() {
        let fragment_start = partition.video_absolute + *fragment as u64 * partition.fragment_size;
        let length = fragment_length(recording, partition, position);
        let mut copied = 0_u64;
        while copied < length {
            let requested = (length - copied).min(COPY_CHUNK) as usize;
            let chunk = read_vec(source, fragment_start + copied, requested)
                .map_err(|error| DhfsError::Io(format!("card read failed inside fragment {fragment}; partial output retained: {error}")))?;
            if position == 0 && copied == 0 {
                let result = probe_stream(&chunk[..chunk.len().min(PROBE_BYTES)]);
                let trim = (result.stream_start as usize).min(chunk.len());
                sink.write_all(&chunk[trim..])?;
                probe = Some(result);
            } else {
                sink.write_all(&chunk)?;
            }
            copied += requested as u64;
        }
    }
    Ok(ExtractReport {
        bytes_written: sink.written,
        sha256: format!("{:x}", sink.hasher.clone().finalize()),
        probe: probe.unwrap_or_else(|| probe_stream(&[])),
        fragments_copied: recording.fragments.len() as u32,
        kind: ContentKind::RawStream,
        stats: ExtractionStats { source_bytes_read: recording.bytes, ..ExtractionStats::default() },
    })
}

/// Write a recording into `sink` as a decodable DHAV stream: only frames the camera dated inside this
/// recording, whole and in order, starting at a key frame, with the filesystem's bookkeeping blocks and a
/// previous occupant's leftovers removed. Falls back to a header-trimmed raw copy when the region holds no
/// DHAV frames at all.
pub fn extract_recording(source: &mut dyn BlockSource, volume: &Volume, recording: &Recording, sink: &mut dyn Write) -> Result<ExtractReport, DhfsError> {
    let partition = volume.partitions.iter().find(|partition| partition.index == recording.partition_index)
        .ok_or_else(|| DhfsError::Layout(format!("partition {} is not part of this volume", recording.partition_index)))?;
    if recording.fragments.is_empty() { return Err(DhfsError::Layout("recording has no fragments".to_string())); }
    let mut sink = HashingSink { inner: sink, hasher: Sha256::new(), written: 0 };
    if let Some((probe, stats)) = extract_dhav_frames(source, partition, recording, &mut sink, None)? {
        return Ok(ExtractReport {
            bytes_written: sink.written,
            sha256: format!("{:x}", sink.hasher.finalize()),
            probe,
            fragments_copied: recording.fragments.len() as u32,
            kind: ContentKind::DhavVideo,
            stats,
        });
    }
    extract_raw_stream(source, volume, recording, &mut sink)
}

/// Stop a head-only walk once this much has been written, whatever the frame count: one HEVC key frame at
/// 2304×1296 is ~200 KB, so this is generous for a thumbnail and still a fraction of a recording.
const HEAD_MAX_BYTES: u64 = 3 << 20;

/// The first few decodable frames of a recording — enough for a thumbnail — read from the card with the
/// same frame filter as a full extraction (only frames the camera dated inside this recording, from its
/// first key frame), so the picture is this recording's and never a previous occupant's leftovers. `None`
/// when the region holds no DHAV frames (raw-stream cards), which the caller treats as "no thumbnail".
pub fn extract_recording_head(source: &mut dyn BlockSource, volume: &Volume, recording: &Recording, sink: &mut dyn Write, video_frames: u32) -> Result<Option<ExtractReport>, DhfsError> {
    let partition = volume.partitions.iter().find(|partition| partition.index == recording.partition_index)
        .ok_or_else(|| DhfsError::Layout(format!("partition {} is not part of this volume", recording.partition_index)))?;
    if recording.fragments.is_empty() { return Err(DhfsError::Layout("recording has no fragments".to_string())); }
    let mut sink = HashingSink { inner: sink, hasher: Sha256::new(), written: 0 };
    Ok(extract_dhav_frames(source, partition, recording, &mut sink, Some(video_frames.max(1)))?.map(|(probe, stats)| ExtractReport {
        bytes_written: sink.written, sha256: format!("{:x}", sink.hasher.finalize()), probe, fragments_copied: 0, kind: ContentKind::DhavVideo, stats,
    }))
}

struct HashingSink<'a> { inner: &'a mut dyn Write, hasher: Sha256, written: u64 }

impl HashingSink<'_> {
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), DhfsError> {
        self.inner.write_all(bytes).map_err(|error| DhfsError::Io(format!("clip write failed: {error}")))?;
        self.hasher.update(bytes);
        self.written += bytes.len() as u64;
        Ok(())
    }
}

fn fragment_length(recording: &Recording, partition: &Partition, position: usize) -> u64 {
    if position + 1 == recording.fragments.len() {
        recording.bytes - (recording.fragments.len() as u64 - 1) * partition.fragment_size
    } else {
        partition.fragment_size
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedClip {
    /// The clip file, or for pictures the folder holding one JPEG per picture.
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    /// SHA-256 of the clip file; for pictures, of every picture's bytes in capture order.
    pub sha256: String,
    pub content_type: String,
    pub codec: String,
    pub stream_start_offset: u64,
    pub channel: u32,
    pub start: DhfsTime,
    pub end: DhfsTime,
    pub duration_seconds: i64,
    pub fragments: u32,
    pub descriptor: u32,
    pub partition_index: u32,
    pub kind: ContentKind,
    pub stats: ExtractionStats,
    pub pictures: Vec<ExtractedPicture>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedPicture {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub taken_at: DhfsTime,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn codec_label(probe: &StreamProbe) -> String {
    match &probe.stream {
        StreamKind::Dhav { first_frame } => format!("dhav/{}", first_frame.video_codec.clone().unwrap_or_else(|| "unknown".to_string())),
        StreamKind::ElementaryH264 => "avc".to_string(),
        StreamKind::ElementaryH265 => "hevc".to_string(),
        StreamKind::Unknown => "unknown".to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// Picture stream: back-to-back JPEGs, each carrying a `DHAV` 0xfb header inside a comment segment
// ---------------------------------------------------------------------------------------------

/// One JPEG found in a byte run: its span and the capture time Dahua embeds in a COM segment.
struct JpegSpan { start: usize, end: usize, taken_at: Option<DhfsTime>, width: Option<u32>, height: Option<u32> }

/// Parse the JPEG starting at `start` (must be `FF D8`). Tolerates the runs of zero bytes Dahua leaves
/// between marker segments, exactly as libjpeg does ("extraneous bytes before marker"). `None` when the
/// image is not complete within `buf`.
fn parse_jpeg(buf: &[u8], start: usize) -> Option<JpegSpan> {
    let mut i = start + 2;
    let (mut taken_at, mut width, mut height) = (None, None, None);
    loop {
        // Skip filler until the next marker; give up on a gap longer than a plausible comment.
        let mut skipped = 0_usize;
        while i < buf.len() && buf[i] != 0xff { i += 1; skipped += 1; if skipped > 64 * 1024 { return None; } }
        while i + 1 < buf.len() && buf[i + 1] == 0xff { i += 1; }
        if i + 4 > buf.len() { return None; }
        let marker = buf[i + 1];
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) { i += 2; continue; }
        let length = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if length < 2 || i + 2 + length > buf.len() { return None; }
        let body = &buf[i + 4..i + 2 + length];
        match marker {
            0xfe => {
                if let Some(k) = find(body, b"DHAV\xfb") {
                    if body.len() >= k + 20 { taken_at = Some(DhfsTime::decode(le_u32(&body[k + 16..k + 20]))); }
                }
            }
            0xc0 | 0xc1 | 0xc2 if body.len() >= 5 => {
                height = Some(u16::from_be_bytes([body[1], body[2]]) as u32);
                width = Some(u16::from_be_bytes([body[3], body[4]]) as u32);
            }
            _ => {}
        }
        i += 2 + length;
        if marker == 0xda {
            // Entropy-coded data: FF is always followed by 00 or a restart marker, so FF D9 is the true end.
            let end = find(&buf[i..], b"\xff\xd9")? + i + 2;
            return Some(JpegSpan { start, end, taken_at, width, height });
        }
    }
}

struct PictureScan { stats: ExtractionStats, hasher: Sha256, total_bytes: u64 }

/// Walk the recording's bytes as JPEG pictures, keeping those the camera dated inside this recording.
fn extract_pictures(source: &mut dyn BlockSource, partition: &Partition, recording: &Recording, mut emit: impl FnMut(&[u8], DhfsTime, Option<u32>, Option<u32>) -> Result<(), DhfsError>) -> Result<PictureScan, DhfsError> {
    let (window_begin, window_end) = window_for(recording);
    let mut reader = RecordingBytes::new(source, partition, recording);
    let mut buf: Vec<u8> = Vec::with_capacity(2 * COPY_CHUNK as usize);
    let mut pos = 0_usize;
    let mut eof = false;
    let mut scan = PictureScan { stats: ExtractionStats::default(), hasher: Sha256::new(), total_bytes: 0 };
    let mut erased_run = 0_usize;
    loop {
        if pos > SCAN_COMPACT_BYTES { buf.drain(..pos); pos = 0; }
        let Some(rel) = find(&buf[pos..], b"\xff\xd8\xff") else {
            let span = &buf[pos..];
            if scan.stats.pictures > 0 && span.iter().all(|byte| *byte == 0xff) { erased_run += span.len(); if erased_run >= ERASED_RUN_BYTES { break; } } else { erased_run = 0; }
            let keep = 2.min(span.len());
            scan.stats.unstructured_bytes += (span.len() - keep) as u64;
            pos = buf.len() - keep;
            if eof { scan.stats.unstructured_bytes += keep as u64; break; }
            if !reader.fill(&mut buf)? { eof = true; }
            continue;
        };
        erased_run = 0;
        scan.stats.unstructured_bytes += rel as u64;
        pos += rel;
        let Some(span) = parse_jpeg(&buf, pos) else {
            if eof || buf.len() - pos > 4 * COPY_CHUNK as usize { scan.stats.unstructured_bytes += 2; pos += 2; continue; }
            if !reader.fill(&mut buf)? { eof = true; }
            continue;
        };
        let picture = &buf[span.start..span.end];
        match span.taken_at {
            Some(at) if (window_begin..=window_end).contains(&at.naive_epoch_seconds()) => {
                emit(picture, at, span.width, span.height)?;
                scan.hasher.update(picture);
                scan.total_bytes += picture.len() as u64;
                scan.stats.pictures += 1;
                if scan.stats.content_start.is_none() { scan.stats.content_start = Some(at); }
                scan.stats.content_end = Some(at);
            }
            Some(at) => {
                if scan.stats.pictures > 0 && at.naive_epoch_seconds() > window_end { scan.stats.stopped_at_next_recording = true; break; }
                scan.stats.stale_frames += 1;
                scan.stats.stale_bytes += picture.len() as u64;
            }
            None => { scan.stats.unstructured_bytes += picture.len() as u64; }
        }
        pos = span.end;
    }
    scan.stats.structural_bytes_removed = reader.structural_removed;
    scan.stats.source_bytes_read = reader.bytes_read;
    Ok(scan)
}

/// The evidence-style file stem every extraction of this recording gets, so a copy made earlier can be found again.
/// `r2` marks the frame-validated extraction rule; copies made by the earlier rule carry no suffix and are not reused.
pub fn recording_file_stem(recording: &Recording, label: &str) -> String {
    let safe_label: String = label.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    format!(
        "FCM-{safe_label}-p{}-d{:06}-{}-{}-ch{:02}-r2",
        recording.partition_index, recording.descriptor, recording.start.file_stamp(), recording.end.file_stamp(), recording.channel
    )
}

fn hash_file(path: &Path) -> Result<(u64, String, Vec<u8>), DhfsError> {
    let mut file = File::open(path).map_err(|error| DhfsError::Io(format!("could not open {}: {error}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut head: Vec<u8> = Vec::new();
    let mut buffer = vec![0_u8; COPY_CHUNK as usize];
    let mut bytes = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(|error| DhfsError::Io(format!("could not read {}: {error}", path.display())))?;
        if count == 0 { break; }
        if head.len() < PROBE_BYTES { head.extend_from_slice(&buffer[..count.min(PROBE_BYTES - head.len())]); }
        hasher.update(&buffer[..count]);
        bytes += count as u64;
    }
    Ok((bytes, format!("{:x}", hasher.finalize()), head))
}

fn clip_shell(recording: &Recording, path: &Path, file_name: String, bytes: u64, sha256: String, content_type: String, codec: String, kind: ContentKind, stats: ExtractionStats) -> ExtractedClip {
    ExtractedClip {
        path: path.to_string_lossy().to_string(),
        file_name,
        bytes,
        sha256,
        content_type,
        codec,
        stream_start_offset: 0,
        channel: recording.channel,
        start: recording.start,
        end: recording.end,
        duration_seconds: recording.duration_seconds,
        fragments: recording.fragments.len() as u32,
        descriptor: recording.descriptor,
        partition_index: recording.partition_index,
        kind,
        stats,
        pictures: Vec::new(),
    }
}

fn picture_file_name(stem: &str, index: u32, taken_at: &DhfsTime) -> String { format!("{stem}-{index:04}-{}.jpg", taken_at.file_stamp()) }

/// A finished copy of `recording` already in `directory`, re-hashed from its bytes (the hash is never
/// taken on trust from a name). `None` when no finished copy exists; `.part` files are never accepted.
pub fn existing_extracted_clip(recording: &Recording, directory: &Path, label: &str) -> Result<Option<ExtractedClip>, DhfsError> {
    let stem = recording_file_stem(recording, label);
    if let Some((path, file_name)) = ["dav", "h264", "h265", "dhfs"].iter().map(|extension| format!("{stem}.{extension}")).map(|name| (directory.join(&name), name)).find(|(path, _)| path.is_file()) {
        let (bytes, sha256, head) = hash_file(&path)?;
        if bytes == 0 { return Ok(None); }
        let probe = probe_stream(&head);
        let kind = if matches!(probe.stream, StreamKind::Dhav { .. }) { ContentKind::DhavVideo } else { ContentKind::RawStream };
        let stats = if kind == ContentKind::DhavVideo { summarize_dhav_file(&path)? } else { ExtractionStats::default() };
        return Ok(Some(clip_shell(recording, &path, file_name, bytes, sha256, probe.content_type.clone(), codec_label(&probe), kind, stats)));
    }
    let folder = directory.join(&stem);
    if folder.is_dir() {
        let mut names: Vec<String> = fs::read_dir(&folder).map_err(|error| DhfsError::Io(error.to_string()))?
            .filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".jpg") && name.starts_with(&stem)).collect();
        if names.is_empty() { return Ok(None); }
        names.sort();
        let mut pictures = Vec::new();
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        for name in names {
            let path = folder.join(&name);
            let data = fs::read(&path).map_err(|error| DhfsError::Io(format!("could not read {}: {error}", path.display())))?;
            let Some(span) = parse_jpeg(&data, 0) else { continue; };
            let Some(taken_at) = span.taken_at else { continue; };
            hasher.update(&data);
            total += data.len() as u64;
            pictures.push(ExtractedPicture { path: path.to_string_lossy().to_string(), file_name: name, bytes: data.len() as u64, sha256: format!("{:x}", Sha256::digest(&data)), taken_at, width: span.width, height: span.height });
        }
        if pictures.is_empty() { return Ok(None); }
        let stats = ExtractionStats { pictures: pictures.len() as u32, content_start: pictures.first().map(|p| p.taken_at), content_end: pictures.last().map(|p| p.taken_at), ..ExtractionStats::default() };
        let mut clip = clip_shell(recording, &folder, stem, total, format!("{:x}", hasher.finalize()), "image/jpeg".to_string(), "jpeg".to_string(), ContentKind::Pictures, stats);
        clip.pictures = pictures;
        return Ok(Some(clip));
    }
    Ok(None)
}

fn commit_part(part_path: &Path, ready_path: &Path) -> Result<(), DhfsError> {
    if ready_path.exists() {
        let _ = fs::remove_file(part_path);
        return Err(DhfsError::Io(format!("{} already exists; existing evidence is never overwritten", ready_path.display())));
    }
    fs::rename(part_path, ready_path).map_err(|error| DhfsError::Io(format!("could not commit {}: {error}", ready_path.display())))
}

/// Extract a recording into `directory` with an evidence-style name, writing to a `.part` file
/// and renaming only after fsync so a half-copied clip can never be mistaken for a finished one.
/// Video becomes one `.dav`/`.h26x` file; a picture stream becomes a folder of JPEGs, one per picture.
pub fn extract_recording_to_directory(source: &mut dyn BlockSource, volume: &Volume, recording: &Recording, directory: &Path, label: &str) -> Result<ExtractedClip, DhfsError> {
    fs::create_dir_all(directory).map_err(|error| DhfsError::Io(format!("could not create {}: {error}", directory.display())))?;
    let partition = volume.partitions.iter().find(|partition| partition.index == recording.partition_index)
        .ok_or_else(|| DhfsError::Layout(format!("partition {} is not part of this volume", recording.partition_index)))?;
    if recording.fragments.is_empty() { return Err(DhfsError::Layout("recording has no fragments".to_string())); }
    let stem = recording_file_stem(recording, label);
    let part_path: PathBuf = directory.join(format!("{stem}.part"));
    let mut part = OpenOptions::new().write(true).create_new(true).open(&part_path)
        .map_err(|error| DhfsError::Io(format!("could not create {}: {error}", part_path.display())))?;

    // 1. DHAV video frames dated inside the recording.
    let mut sink = HashingSink { inner: &mut part, hasher: Sha256::new(), written: 0 };
    let video = match extract_dhav_frames(source, partition, recording, &mut sink, None) {
        Ok(video) => video,
        Err(error) => { drop(sink); let _ = fs::remove_file(&part_path); return Err(error); }
    };
    if let Some((probe, stats)) = video {
        let (bytes, sha256) = (sink.written, format!("{:x}", sink.hasher.finalize()));
        part.flush().map_err(|error| DhfsError::Io(error.to_string()))?;
        part.sync_all().map_err(|error| DhfsError::Io(error.to_string()))?;
        drop(part);
        let file_name = format!("{stem}.{}", probe.extension);
        let ready_path = directory.join(&file_name);
        commit_part(&part_path, &ready_path)?;
        return Ok(clip_shell(recording, &ready_path, file_name, bytes, sha256, probe.content_type.clone(), codec_label(&probe), ContentKind::DhavVideo, stats));
    }
    drop(sink);

    // 2. Picture stream: one JPEG file per in-window picture, in a folder named after the recording.
    let folder = directory.join(&stem);
    let folder_part = directory.join(format!("{stem}.part-dir"));
    fs::create_dir_all(&folder_part).map_err(|error| DhfsError::Io(format!("could not create {}: {error}", folder_part.display())))?;
    let mut pictures: Vec<ExtractedPicture> = Vec::new();
    let scan = extract_pictures(source, partition, recording, |picture, taken_at, width, height| {
        let name = picture_file_name(&stem, pictures.len() as u32 + 1, &taken_at);
        let path = folder_part.join(&name);
        fs::write(&path, picture).map_err(|error| DhfsError::Io(format!("could not write {}: {error}", path.display())))?;
        pictures.push(ExtractedPicture { path: folder.join(&name).to_string_lossy().to_string(), file_name: name, bytes: picture.len() as u64, sha256: format!("{:x}", Sha256::digest(picture)), taken_at, width, height });
        Ok(())
    });
    let scan = match scan {
        Ok(scan) => scan,
        Err(error) => { let _ = fs::remove_dir_all(&folder_part); let _ = fs::remove_file(&part_path); return Err(error); }
    };
    if scan.stats.pictures > 0 {
        let _ = fs::remove_file(&part_path);
        if folder.exists() {
            let _ = fs::remove_dir_all(&folder_part);
            return Err(DhfsError::Io(format!("{} already exists; existing evidence is never overwritten", folder.display())));
        }
        fs::rename(&folder_part, &folder).map_err(|error| DhfsError::Io(format!("could not commit {}: {error}", folder.display())))?;
        let mut clip = clip_shell(recording, &folder, stem, scan.total_bytes, format!("{:x}", scan.hasher.finalize()), "image/jpeg".to_string(), "jpeg".to_string(), ContentKind::Pictures, scan.stats);
        clip.pictures = pictures;
        return Ok(clip);
    }
    let _ = fs::remove_dir_all(&folder_part);

    // 3. Nothing the frame walk recognises: copy the region as it lies (older firmware, raw elementary streams).
    let mut sink = HashingSink { inner: &mut part, hasher: Sha256::new(), written: 0 };
    let report = match extract_raw_stream(source, volume, recording, &mut sink) {
        Ok(report) => report,
        Err(error) => { drop(sink); let _ = fs::remove_file(&part_path); return Err(error); }
    };
    drop(sink);
    part.flush().map_err(|error| DhfsError::Io(error.to_string()))?;
    part.sync_all().map_err(|error| DhfsError::Io(error.to_string()))?;
    drop(part);
    let file_name = format!("{stem}.{}", report.probe.extension);
    let ready_path = directory.join(&file_name);
    commit_part(&part_path, &ready_path)?;
    let mut clip = clip_shell(recording, &ready_path, file_name, report.bytes_written, report.sha256, report.probe.content_type.clone(), codec_label(&report.probe), ContentKind::RawStream, report.stats);
    clip.stream_start_offset = report.probe.stream_start;
    Ok(clip)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_LBA: u64 = 2048;
    const PARTITION_REL: u64 = 0x20000;
    const SUPERBLOCK_REL: u64 = 0x1000;
    const DESC_BLOCKS: u32 = 32;
    const VIDEO_BLOCKS: u32 = 128;
    const FRAG_BLOCKS: u32 = 16;
    const FRAG_SIZE: usize = FRAG_BLOCKS as usize * 512;

    fn put(image: &mut [u8], offset: u64, bytes: &[u8]) { image[offset as usize..offset as usize + bytes.len()].copy_from_slice(bytes); }

    fn time(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> DhfsTime { DhfsTime { year: y, month: mo, day: d, hour: h, minute: mi, second: s } }

    /// The first 64 bytes of a key frame from a real card (extracted 2026-07-24 recording, ch129): the
    /// resolution extension is 4 bytes, the codec extension follows it, then an 8-byte 0x88 and the HEVC VPS.
    const REAL_KEY_FRAME_HEAD: [u8; 64] = [
        0x44, 0x48, 0x41, 0x56, 0xfd, 0x00, 0x00, 0x00, 0x6a, 0x75, 0x04, 0x00, 0xc1, 0x93, 0x01, 0x00,
        0x15, 0x02, 0xf1, 0x69, 0xbf, 0x8c, 0x10, 0x24, 0x80, 0x00, 0xf0, 0x87, 0x81, 0x06, 0x0c, 0x03,
        0x88, 0x0b, 0xb0, 0xdf, 0x38, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01,
        0xff, 0xff, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xb0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00,
    ];

    #[test]
    fn parses_a_real_key_frame_header() {
        let frame = dhav_frame_header(&REAL_KEY_FRAME_HEAD).expect("header");
        assert_eq!((frame.frame_type, frame.frame_number, frame.frame_length), (0xfd, 292_202, 103_361));
        assert_eq!(frame.date, time(2026, 7, 24, 16, 8, 21));
        assert_eq!((frame.width, frame.height), (Some(1920), Some(1080)));
        assert_eq!(frame.video_codec.as_deref(), Some("hevc"));
        let probe = probe_stream(&REAL_KEY_FRAME_HEAD);
        assert_eq!(codec_label(&probe), "dhav/hevc");
    }

    #[test]
    fn codec_falls_back_to_the_payload_when_the_extension_is_missing() {
        // Same frame with only the resolution extension: the VPS start code after it still identifies HEVC.
        let mut head = REAL_KEY_FRAME_HEAD.to_vec();
        head.drain(28..40);
        head[22] = 4;
        let frame = dhav_frame_header(&head).expect("header");
        assert_eq!(frame.video_codec.as_deref(), Some("hevc"));
        assert_eq!((frame.width, frame.height), (Some(1920), Some(1080)));
    }

    fn descriptor(kind: u8, camera: u8, begin: u32, end: u32, next: u32, last_blocks: u32, prev: u32, first: u32) -> [u8; 32] {
        let mut d = [0_u8; 32];
        d[0] = kind; d[1] = camera;
        d[4..8].copy_from_slice(&begin.to_le_bytes());
        d[8..12].copy_from_slice(&end.to_le_bytes());
        d[12..16].copy_from_slice(&next.to_le_bytes());
        d[16..20].copy_from_slice(&last_blocks.to_le_bytes());
        d[20..24].copy_from_slice(&prev.to_le_bytes());
        d[24..28].copy_from_slice(&first.to_le_bytes());
        d
    }

    fn dhav_frame(payload: &[u8]) -> Vec<u8> {
        let ext: Vec<u8> = vec![0x80, 0x00, 240, 135, 0x81, 0x00, 0x0c, 25]; // 1920x1080, hevc @25fps (real-card layout)
        let frame_length = (24 + ext.len() + payload.len() + 8) as u32;
        let mut frame = Vec::new();
        frame.extend_from_slice(b"DHAV");
        frame.extend_from_slice(&[0xfd, 0x00, 0x02, 0x00]);
        frame.extend_from_slice(&1_u32.to_le_bytes());
        frame.extend_from_slice(&frame_length.to_le_bytes());
        frame.extend_from_slice(&time(2026, 9, 12, 8, 0, 0).encode().to_le_bytes());
        frame.extend_from_slice(&0x0010_u16.to_le_bytes());
        frame.push(ext.len() as u8);
        frame.push(0);
        frame.extend_from_slice(&ext);
        frame.extend_from_slice(payload);
        frame.extend_from_slice(b"dhav");
        frame.extend_from_slice(&frame_length.to_le_bytes());
        frame
    }

    /// Superblock + descriptors + fragments for one DHFS partition, written at `partition_abs`.
    fn write_partition(image: &mut [u8], partition_abs: u64, superblock_rel: u64) {
        let sb = partition_abs + superblock_rel;
        put(image, sb + 0x10, &time(2026, 9, 11, 14, 31, 56).encode().to_le_bytes());
        put(image, sb + 0x14, &time(2026, 9, 12, 8, 0, 30).encode().to_le_bytes());
        put(image, sb + 0x2c, &512_u32.to_le_bytes());
        put(image, sb + 0x30, &FRAG_BLOCKS.to_le_bytes());
        put(image, sb + 0x44, &DESC_BLOCKS.to_le_bytes());
        put(image, sb + 0x48, &VIDEO_BLOCKS.to_le_bytes());
        put(image, sb + 0x4c, &6_u32.to_le_bytes());
        let table = partition_abs + DESC_BLOCKS as u64 * 512;
        let t1 = time(2026, 9, 11, 14, 31, 56).encode();
        let t2 = time(2026, 9, 11, 14, 55, 6).encode();
        let t3 = time(2026, 9, 12, 8, 0, 0).encode();
        let t4 = time(2026, 9, 12, 8, 0, 30).encode();
        put(image, table, &descriptor(0, b'0', 0, 0, 0, 0, 0, 0));
        put(image, table + 32, &descriptor(1, b'0', t1, t2, 2, FRAG_BLOCKS, 0, 1));
        put(image, table + 64, &descriptor(2, b'0', t1, t2, 0, 4, 1, 1));
        put(image, table + 96, &descriptor(1, b'1', t3, t3, 0, 2, 0, 3));
        put(image, table + 128, &descriptor(1, b'2', t3, t4, 0, 6, 0, 4));
        put(image, table + 160, &descriptor(1, b'0', t1, t2, 5, 2, 0, 5));
        let video = partition_abs + VIDEO_BLOCKS as u64 * 512;
        // Fragment 1: DHII header (with a decoy start code that is not a parameter set) then a VPS.
        let mut frag1 = vec![0_u8; FRAG_SIZE];
        frag1[..4].copy_from_slice(b"DHII");
        frag1[4..12].copy_from_slice(&[0, 0, 1, 0x21, 0xaa, 0xbb, 0xcc, 0xdd]); // start code + slice NAL, not a parameter set
        frag1[64..70].copy_from_slice(&[0, 0, 0, 1, 0x40, 0x01]);
        for (i, byte) in frag1[70..].iter_mut().enumerate() { *byte = (i % 251) as u8 + 1; }
        put(image, video + FRAG_SIZE as u64, &frag1);
        let frag2: Vec<u8> = (0..2048).map(|i| (i % 199) as u8 + 3).collect();
        put(image, video + 2 * FRAG_SIZE as u64, &frag2);
        let payload: Vec<u8> = (0..1000).map(|i| (i % 97) as u8).collect();
        put(image, video + 4 * FRAG_SIZE as u64, &dhav_frame(&payload));
    }

    fn mbr_image() -> Vec<u8> {
        let base = BASE_LBA * SECTOR;
        let mut image = vec![0_u8; (base + PARTITION_REL + (VIDEO_BLOCKS as u64) * 512 + 8 * FRAG_SIZE as u64) as usize];
        image[510] = 0x55; image[511] = 0xaa;
        let entry = 446;
        let sectors = (image.len() as u64 / SECTOR - BASE_LBA) as u32;
        image[entry + 4] = 0x83;
        image[entry + 8..entry + 12].copy_from_slice(&(BASE_LBA as u32).to_le_bytes());
        image[entry + 12..entry + 16].copy_from_slice(&sectors.to_le_bytes());
        put(&mut image, base, MAGIC);
        put(&mut image, base + 0x3c00, DPT_MARKER);
        let entry0 = base + 0x3c00 + DPT_ENTRIES_OFFSET;
        put(&mut image, entry0 + 20, &((SUPERBLOCK_REL / SECTOR) as u32).to_le_bytes());
        put(&mut image, entry0 + 48, &(PARTITION_REL / SECTOR).to_le_bytes());
        put(&mut image, entry0 + DPT_ENTRY_SIZE, &DPT_TERMINATOR);
        write_partition(&mut image, base + PARTITION_REL, SUPERBLOCK_REL);
        image
    }

    fn device_start_image() -> Vec<u8> {
        let mut image = vec![0_u8; (VIDEO_BLOCKS as u64) as usize * 512 + 8 * FRAG_SIZE];
        put(&mut image, 0, MAGIC);
        put(&mut image, 0x3c00, DPT_MARKER);
        // Partition-table entries left all zero: the real card that shaped V1 looked like this.
        write_partition(&mut image, 0, 0x3c00 + SINGLE_PARTITION_SUPERBLOCK_OFFSET);
        image
    }

    #[test]
    fn decodes_and_round_trips_dahua_timestamps() {
        let t = time(2026, 9, 11, 14, 31, 56);
        assert_eq!(DhfsTime::decode(t.encode()), t);
        assert_eq!(t.to_string(), "2026-09-11 14:31:56");
        assert_eq!(t.file_stamp(), "2026-09-11_14-31-56");
        assert_eq!(time(1970, 1, 1, 0, 0, 0).naive_epoch_seconds(), 0);
        assert_eq!(time(2026, 9, 11, 14, 55, 6).naive_epoch_seconds() - t.naive_epoch_seconds(), 23 * 60 + 10);
        assert!(!DhfsTime::decode(0).is_plausible());
    }

    #[test]
    fn locates_the_volume_behind_an_mbr_partition() {
        let mut source = MemorySource(mbr_image());
        let location = locate_volume(&mut source).expect("located");
        assert_eq!(location.base_offset, BASE_LBA * SECTOR);
        assert_eq!(location.method, LocationMethod::MbrPartition { index: 0, type_code: 0x83, first_lba: BASE_LBA as u32 });
    }

    #[test]
    fn locates_a_raw_volume_at_sector_zero_and_by_scan() {
        let mut raw = MemorySource(device_start_image());
        assert_eq!(locate_volume(&mut raw).expect("located").method, LocationMethod::DeviceStart);
        let mut shifted = vec![0_u8; 4 * 1024 * 1024];
        shifted.extend_from_slice(&device_start_image());
        let mut source = MemorySource(shifted);
        let location = locate_volume(&mut source).expect("located by scan");
        assert_eq!(location.method, LocationMethod::Scan);
        assert_eq!(location.base_offset, 4 * 1024 * 1024);
        let mut blank = MemorySource(vec![0_u8; 8 * 1024 * 1024]);
        assert!(matches!(locate_volume(&mut blank), Err(DhfsError::NotDhfs(_))));
    }

    #[test]
    fn reads_the_partition_table_through_the_dpt_marker() {
        let mut source = MemorySource(mbr_image());
        let volume = open_volume(&mut source).expect("volume");
        assert_eq!(volume.dpt_marker_offset, BASE_LBA * SECTOR + 0x3c00);
        assert_eq!(volume.partitions.len(), 1);
        let partition = &volume.partitions[0];
        assert_eq!(partition.partition_offset, PARTITION_REL);
        assert_eq!(partition.superblock_offset, SUPERBLOCK_REL);
        assert_eq!(partition.block_size, 512);
        assert_eq!(partition.fragment_size, FRAG_SIZE as u64);
        assert_eq!(partition.descriptor_count, 6);
        assert_eq!(partition.first_date, Some(time(2026, 9, 11, 14, 31, 56)));
        assert_eq!(partition.last_date, Some(time(2026, 9, 12, 8, 0, 30)));
        assert!(volume.table_note.contains("terminator"));
    }

    #[test]
    fn falls_back_to_the_single_partition_superblock_when_the_table_is_zero() {
        let mut source = MemorySource(device_start_image());
        let volume = open_volume(&mut source).expect("volume");
        assert_eq!(volume.partitions.len(), 1);
        assert_eq!(volume.partitions[0].superblock_offset, 0x3c00 + SINGLE_PARTITION_SUPERBLOCK_OFFSET);
        assert!(volume.table_note.contains("0x6c0"));
        let recordings = list_recordings(&mut source, &volume).expect("catalog").recordings;
        assert_eq!(recordings.len(), 2);
    }

    #[test]
    fn lists_only_trustworthy_recordings_and_explains_the_rest() {
        let mut source = MemorySource(mbr_image());
        let catalog = catalog(&mut source).expect("catalog");
        assert_eq!(catalog.recordings.len(), 2);
        let first = &catalog.recordings[0];
        assert_eq!((first.descriptor, first.channel, first.fragment_count), (1, 1, 2));
        assert_eq!(first.fragments, vec![1, 2]);
        assert_eq!(first.bytes, FRAG_SIZE as u64 + 2048);
        assert_eq!(first.start, time(2026, 9, 11, 14, 31, 56));
        assert_eq!(first.duration_seconds, 23 * 60 + 10);
        let second = &catalog.recordings[1];
        assert_eq!((second.descriptor, second.channel, second.fragment_count, second.bytes), (4, 3, 1, 3072));
        assert_eq!(catalog.skipped_descriptors, 2);
        assert!(catalog.warnings.iter().any(|w| w.contains("zero-length")));
        assert!(catalog.warnings.iter().any(|w| w.contains("cyclic")));
    }

    #[test]
    fn extracts_an_elementary_stream_and_trims_the_dhii_header() {
        let mut source = MemorySource(mbr_image());
        let catalog = catalog(&mut source).expect("catalog");
        let recording = &catalog.recordings[0];
        let mut out = Vec::new();
        let report = extract_recording(&mut source, &catalog.volume, recording, &mut out).expect("extract");
        assert_eq!(report.probe.stream, StreamKind::ElementaryH265);
        assert_eq!(report.probe.stream_start, 64);
        assert!(report.probe.has_dhii_header);
        assert_eq!(report.probe.extension, "h265");
        assert_eq!(out.len() as u64, recording.bytes - 64);
        assert_eq!(report.bytes_written, out.len() as u64);
        assert_eq!(&out[..6], &[0, 0, 0, 1, 0x40, 0x01]);
        assert_eq!(&out[out.len() - 2048..], &(0..2048).map(|i| (i % 199) as u8 + 3).collect::<Vec<u8>>()[..]);
        assert_eq!(report.sha256, format!("{:x}", Sha256::digest(&out)));
    }

    #[test]
    fn recognises_dhav_frames_and_keeps_them_verbatim() {
        let mut source = MemorySource(mbr_image());
        let catalog = catalog(&mut source).expect("catalog");
        let recording = &catalog.recordings[1];
        let mut out = Vec::new();
        let report = extract_recording(&mut source, &catalog.volume, recording, &mut out).expect("extract");
        match &report.probe.stream {
            StreamKind::Dhav { first_frame } => {
                assert_eq!(first_frame.video_codec.as_deref(), Some("hevc"));
                assert_eq!((first_frame.width, first_frame.height, first_frame.frame_rate), (Some(1920), Some(1080), Some(25)));
                assert_eq!(first_frame.frame_type, 0xfd);
                assert_eq!(first_frame.date, time(2026, 9, 12, 8, 0, 0));
                assert!(first_frame.trailer_verified);
            }
            other => panic!("expected DHAV, got {other:?}"),
        }
        assert_eq!(report.probe.stream_start, 0);
        assert_eq!(report.probe.extension, "dav");
        assert_eq!(report.kind, ContentKind::DhavVideo);
        // Only the frame itself is written: the fragment's zero padding is not part of the recording.
        assert_eq!(out.len(), 24 + 8 + 1000 + 8);
        assert_eq!(&out[..4], b"DHAV");
        assert_eq!((report.stats.frames_kept, report.stats.key_frames, report.stats.stale_frames), (1, 1, 0));
        assert_eq!(report.stats.content_start, Some(time(2026, 9, 12, 8, 0, 0)));
        assert_eq!(codec_label(&report.probe), "dhav/hevc");
    }

    fn dated_frame(kind: u8, frame_no: u32, at: DhfsTime, payload_len: usize) -> Vec<u8> {
        let ext: Vec<u8> = vec![0x80, 0x00, 240, 135, 0x81, 0x00, 0x0c, 3];
        let frame_length = (24 + ext.len() + payload_len + 8) as u32;
        let mut frame = Vec::new();
        frame.extend_from_slice(b"DHAV");
        frame.extend_from_slice(&[kind, 0x00, 0x00, 0x00]);
        frame.extend_from_slice(&frame_no.to_le_bytes());
        frame.extend_from_slice(&frame_length.to_le_bytes());
        frame.extend_from_slice(&at.encode().to_le_bytes());
        frame.extend_from_slice(&0x0010_u16.to_le_bytes());
        frame.push(ext.len() as u8);
        frame.push(0);
        frame.extend_from_slice(&ext);
        frame.extend((0..payload_len).map(|i| (i % 253) as u8 + 1));
        frame.extend_from_slice(b"dhav");
        frame.extend_from_slice(&frame_length.to_le_bytes());
        frame
    }

    /// A raw volume (no partition table) with one channel-0 recording spanning two 1 MiB fragments, laid out
    /// the way the real card was measured: header + JSON with the word DHAV in it, stale frames from an
    /// earlier occupant, the recording's own frames from a P-frame, a checkpoint block closing every
    /// 512-block group (frames straddle it), then erased flash.
    fn measured_layout_image() -> (Vec<u8>, Vec<u8>, DhfsTime, DhfsTime) {
        const BLOCK: usize = 512;
        const FRAG_BLOCKS: u32 = 2048; // 1 MiB fragments -> 256 KiB groups
        const FRAG: usize = FRAG_BLOCKS as usize * BLOCK;
        const GROUP: usize = 512 * BLOCK;
        const VIDEO_BLOCKS: u32 = 64;
        let begin = time(2026, 7, 24, 14, 39, 0);
        let end = time(2026, 7, 24, 14, 39, 16);
        let stale_at = time(2026, 6, 16, 13, 44, 6);
        let later_at = time(2026, 7, 24, 14, 45, 0);
        let mut image = vec![0_u8; VIDEO_BLOCKS as usize * BLOCK + 3 * FRAG];
        put(&mut image, 0, MAGIC);
        put(&mut image, 0x3c00, DPT_MARKER);
        let sb = 0x3c00 + SINGLE_PARTITION_SUPERBLOCK_OFFSET;
        put(&mut image, sb + 0x2c, &(BLOCK as u32).to_le_bytes());
        put(&mut image, sb + 0x30, &FRAG_BLOCKS.to_le_bytes());
        put(&mut image, sb + 0x44, &32_u32.to_le_bytes());
        put(&mut image, sb + 0x48, &VIDEO_BLOCKS.to_le_bytes());
        put(&mut image, sb + 0x4c, &3_u32.to_le_bytes());
        let table = 32 * BLOCK as u64;
        // Descriptor 1: main, fragments 1 -> 2; the last-fragment size deliberately under-reports (1 block).
        put(&mut image, table + 32, &descriptor(1, b'0', begin.encode(), end.encode(), 2, 1, 0, 1));
        put(&mut image, table + 64, &descriptor(2, b'0', begin.encode(), end.encode(), 0, 1, 1, 1));
        // Two fragments as one erased span; a writer that skips the checkpoint block closing each group.
        let mut area = vec![0xff_u8; 2 * FRAG];
        let mut checkpoint = vec![0_u8; BLOCK];
        checkpoint[..4].copy_from_slice(&[0x16, 0xbd, 0xef, 0xc5]);
        checkpoint[4..8].copy_from_slice(&CHECKPOINT_MAGIC);
        for group_end in (GROUP..=2 * FRAG).step_by(GROUP) { area[group_end - BLOCK..group_end].copy_from_slice(&checkpoint); }
        let mut cursor = 0_usize;
        let write = |area: &mut Vec<u8>, cursor: &mut usize, bytes: &[u8]| {
            let mut written = 0;
            while written < bytes.len() {
                if *cursor % GROUP == GROUP - BLOCK { *cursor += BLOCK; }
                let room = (GROUP - BLOCK) - *cursor % GROUP;
                let take = room.min(bytes.len() - written);
                area[*cursor..*cursor + take].copy_from_slice(&bytes[written..written + take]);
                *cursor += take; written += take;
            }
        };
        let header = br#"DHII....{"Encode":{"Format":"DHAV"},"Video":{"Compression":"H.265","Pack":"DHAV"}}"#;
        write(&mut area, &mut cursor, header);
        cursor = 4096;
        for (kind, no) in [(0xfd_u8, 100_u32), (0xfc, 101)] { write(&mut area, &mut cursor, &dated_frame(kind, no, stale_at, 3000)); }
        cursor = 200_000;
        write(&mut area, &mut cursor, &dated_frame(0xfc, 1, begin, 500));
        let mut stream: Vec<u8> = Vec::new(); // the recording as a decoder should see it
        let mut frame_no = 2;
        while cursor < FRAG + 3 * BLOCK {
            let kind = if frame_no % 4 == 2 { 0xfd } else { 0xfc };
            let at = if cursor < FRAG - 60_000 { begin } else { end };
            let f = dated_frame(kind, frame_no, at, if kind == 0xfd { 40_000 } else { 9_000 });
            stream.extend_from_slice(&f);
            write(&mut area, &mut cursor, &f);
            frame_no += 1;
        }
        // The next recording begins right after in the same fragment: it must not be swept up.
        write(&mut area, &mut cursor, &dated_frame(0xfd, 1, later_at, 5_000));
        let video = VIDEO_BLOCKS as u64 * BLOCK as u64;
        put(&mut image, video + FRAG as u64, &area);
        (image, stream, begin, end)
    }

    #[test]
    fn keeps_only_the_recordings_own_frames_and_removes_bookkeeping_blocks() {
        let (image, expected, begin, end) = measured_layout_image();
        let mut source = MemorySource(image);
        let catalog = catalog(&mut source).expect("catalog");
        assert_eq!(catalog.recordings.len(), 1);
        let recording = &catalog.recordings[0];
        assert_eq!(recording.fragments, vec![1, 2]);
        let mut out = Vec::new();
        let report = extract_recording(&mut source, &catalog.volume, recording, &mut out).expect("extract");
        assert_eq!(report.kind, ContentKind::DhavVideo);
        assert_eq!(out, expected, "output is exactly the recording's frames, whole and in order");
        assert_eq!(&out[..5], b"DHAV\xfd", "starts at a key frame");
        assert_eq!(report.stats.stale_frames, 2);
        assert_eq!(report.stats.leading_frames_dropped, 1);
        assert!(report.stats.structural_bytes_removed >= 512 * 4, "checkpoint blocks removed: {}", report.stats.structural_bytes_removed);
        assert_eq!(report.stats.content_start, Some(begin));
        assert_eq!(report.stats.content_end, Some(end));
        assert!(report.stats.stopped_at_next_recording);
        assert!(!report.stats.truncated_final_frame);
        assert_eq!(report.sha256, format!("{:x}", Sha256::digest(&out)));
    }

    #[test]
    fn a_head_read_starts_at_the_same_key_frame_and_stops_early() {
        let (image, expected, begin, _) = measured_layout_image();
        let mut source = MemorySource(image);
        let catalog = catalog(&mut source).expect("catalog");
        let recording = &catalog.recordings[0];
        let mut head = Vec::new();
        let report = extract_recording_head(&mut source, &catalog.volume, recording, &mut head, 2).expect("head").expect("dhav frames");
        assert_eq!(&head[..5], b"DHAV\xfd", "the head begins at the recording's first key frame, not a stale or leading frame");
        assert_eq!(report.stats.video_frames, 2);
        assert_eq!(report.stats.stale_frames, 2, "the same frame filter as a full extraction applies");
        assert_eq!(report.stats.content_start, Some(begin));
        assert!(head.len() < expected.len(), "a head is a fraction of the recording ({} of {} bytes)", head.len(), expected.len());
        assert_eq!(&expected[..head.len()], &head[..], "the head is a byte-for-byte prefix of the full extraction");
        assert!(report.bytes_written < HEAD_MAX_BYTES);
    }

    fn synthetic_jpeg(taken_at: Option<DhfsTime>, width: u16, height: u16, seed: u8) -> Vec<u8> {
        let mut j = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        j.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        if let Some(at) = taken_at {
            let mut com = Vec::new();
            com.extend_from_slice(b"DHAV\xfb\0\0\0\0\0\0\0\0\0\0\xfc");
            com.extend_from_slice(&at.encode().to_le_bytes());
            com.extend_from_slice(&[0_u8; 200]);
            j.extend_from_slice(&[0xff, 0xfe]);
            j.extend_from_slice(&((com.len() + 2) as u16).to_be_bytes());
            j.extend_from_slice(&com);
            j.extend_from_slice(&[0_u8; 608]); // Dahua's filler between segments
        }
        j.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        j.extend_from_slice(&height.to_be_bytes());
        j.extend_from_slice(&width.to_be_bytes());
        j.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        j.extend_from_slice(&[0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
        j.extend((0..4000_usize).map(|i| { let b = (i as u8).wrapping_mul(31).wrapping_add(seed); if b == 0xff { 0xfe } else { b } }));
        j.extend_from_slice(&[0xff, 0xd9]);
        j
    }

    #[test]
    fn extracts_a_picture_stream_as_dated_jpeg_files() {
        const BLOCK: usize = 512;
        const FRAG_BLOCKS: u32 = 256;
        const FRAG: usize = FRAG_BLOCKS as usize * BLOCK;
        let begin = time(2026, 8, 23, 10, 16, 48);
        let end = time(2026, 8, 23, 10, 16, 54);
        let mut image = vec![0_u8; 64 * BLOCK + 3 * FRAG];
        put(&mut image, 0, MAGIC);
        put(&mut image, 0x3c00, DPT_MARKER);
        let sb = 0x3c00 + SINGLE_PARTITION_SUPERBLOCK_OFFSET;
        put(&mut image, sb + 0x2c, &(BLOCK as u32).to_le_bytes());
        put(&mut image, sb + 0x30, &FRAG_BLOCKS.to_le_bytes());
        put(&mut image, sb + 0x44, &32_u32.to_le_bytes());
        put(&mut image, sb + 0x48, &64_u32.to_le_bytes());
        put(&mut image, sb + 0x4c, &3_u32.to_le_bytes());
        put(&mut image, 32 * BLOCK as u64 + 32, &descriptor(1, b'p', begin.encode(), end.encode(), 0, 100, 0, 1));
        let mut frag = vec![0xff_u8; FRAG];
        frag[..4].copy_from_slice(b"DHII");
        let stale_frame = dated_frame(0xfc, 7, time(2026, 6, 20, 20, 33, 38), 2000);
        frag[1024..1024 + stale_frame.len()].copy_from_slice(&stale_frame);
        let mut cursor = 8192;
        let mut expected = Vec::new();
        for (at, seed) in [(Some(time(2026, 6, 20, 20, 33, 40)), 1_u8), (Some(begin), 2), (Some(time(2026, 8, 23, 10, 16, 50)), 3), (None, 4)] {
            let jpeg = synthetic_jpeg(at, 1920, 1080, seed);
            if matches!(at, Some(t) if t >= begin) { expected.push(jpeg.clone()); }
            frag[cursor..cursor + jpeg.len()].copy_from_slice(&jpeg); cursor += jpeg.len();
        }
        put(&mut image, 64 * BLOCK as u64 + FRAG as u64, &frag);
        let mut source = MemorySource(image);
        let catalog = catalog(&mut source).expect("catalog");
        let dir = std::env::temp_dir().join(format!("fcm-dhfs-pictures-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let clip = extract_recording_to_directory(&mut source, &catalog.volume, &catalog.recordings[0], &dir, "card").expect("clip");
        assert_eq!(clip.kind, ContentKind::Pictures);
        assert_eq!(clip.content_type, "image/jpeg");
        assert_eq!(clip.pictures.len(), 2);
        assert_eq!(clip.stats.pictures, 2);
        assert_eq!(clip.stats.stale_frames, 1, "the June picture is a previous occupant");
        assert_eq!(clip.pictures[0].taken_at, begin);
        assert_eq!((clip.pictures[0].width, clip.pictures[0].height), (Some(1920), Some(1080)));
        assert!(clip.pictures[0].file_name.ends_with("-0001-2026-08-23_10-16-48.jpg"));
        assert_eq!(fs::read(&clip.pictures[0].path).unwrap(), expected[0]);
        assert_eq!(fs::read(&clip.pictures[1].path).unwrap(), expected[1]);
        assert!(Path::new(&clip.path).is_dir());
        assert!(!dir.join(format!("{}.part", clip.file_name)).exists());
        let again = existing_extracted_clip(&catalog.recordings[0], &dir, "card").expect("reuse").expect("found");
        assert_eq!(again.kind, ContentKind::Pictures);
        assert_eq!(again.pictures.len(), 2);
        assert_eq!(again.sha256, clip.sha256);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_clips_atomically_with_evidence_names() {
        let mut source = MemorySource(mbr_image());
        let catalog = catalog(&mut source).expect("catalog");
        let dir = std::env::temp_dir().join(format!("fcm-dhfs-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let clip = extract_recording_to_directory(&mut source, &catalog.volume, &catalog.recordings[0], &dir, "image test").expect("clip");
        assert_eq!(clip.file_name, "FCM-image-test-p0-d000001-2026-09-11_14-31-56-2026-09-11_14-55-06-ch01-r2.h265");
        assert!(Path::new(&clip.path).is_file());
        assert!(!dir.join(format!("{}.part", clip.file_name.trim_end_matches(".h265"))).exists());
        assert_eq!(clip.codec, "hevc");
        assert_eq!(clip.kind, ContentKind::RawStream);
        assert_eq!(clip.stream_start_offset, 64);
        let reused = existing_extracted_clip(&catalog.recordings[0], &dir, "image test").expect("reuse").expect("found");
        assert_eq!((reused.sha256, reused.bytes), (clip.sha256.clone(), clip.bytes));
        let again = extract_recording_to_directory(&mut source, &catalog.volume, &catalog.recordings[0], &dir, "image test");
        assert!(matches!(again, Err(DhfsError::Io(message)) if message.contains("never overwritten")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn summarises_a_finished_dav_file_frame_by_frame() {
        let dir = std::env::temp_dir().join(format!("fcm-dhfs-summary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("clip.dav");
        let mut bytes = Vec::new();
        bytes.extend(dated_frame(0xfd, 1, time(2026, 7, 24, 9, 30, 0), 500));
        bytes.extend(dated_frame(0xf0, 2, time(2026, 7, 24, 9, 30, 0), 40));
        bytes.extend(dated_frame(0xfc, 3, time(2026, 7, 24, 9, 30, 1), 200));
        bytes.extend(dated_frame(0xfd, 4, time(2026, 7, 24, 9, 30, 2), 500));
        let mut cut = dated_frame(0xfc, 5, time(2026, 7, 24, 9, 30, 3), 200);
        cut.truncate(cut.len() - 50);
        bytes.extend(cut);
        fs::write(&path, &bytes).expect("write");
        let stats = summarize_dhav_file(&path).expect("summary");
        assert_eq!((stats.frames_kept, stats.video_frames, stats.key_frames, stats.audio_frames), (4, 3, 2, 1));
        assert_eq!((stats.content_start, stats.content_end), (Some(time(2026, 7, 24, 9, 30, 0)), Some(time(2026, 7, 24, 9, 30, 2))));
        assert!(stats.truncated_final_frame);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn aligned_file_source_reads_unaligned_ranges_from_aligned_windows() {
        let dir = std::env::temp_dir().join(format!("fcm-dhfs-aligned-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("card.img");
        fs::write(&path, mbr_image()).unwrap();
        let mut source = AlignedFileSource::from_file(File::open(&path).unwrap(), Some(mbr_image().len() as u64), DEVICE_READ_ALIGNMENT);
        let catalog = catalog(&mut source).expect("catalog through 4 KiB aligned reads");
        assert_eq!(catalog.recordings.len(), 2);
        let mut tail = [0_u8; 7];
        let len = mbr_image().len() as u64;
        source.read_at(len - 7, &mut tail).expect("tail read stays inside the source");
        assert!(source.read_at(len - 3, &mut tail).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
