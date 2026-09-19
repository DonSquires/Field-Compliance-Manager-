//! Replay a region that FCM Desktop V2 copied off a card through the extractor, to check what the
//! frame walk makes of real bytes without needing the card. The region is wrapped in a synthetic
//! single-fragment DHFS volume at the same fragment-relative alignment it had on the card.
//!
//! cargo run --example replay -- <region-file> <fragment-offset-of-byte-0> <begin YYYY-MM-DD_HH-MM-SS> <end ...> <out-dir>
use fcm_dhfs::{catalog, extract_recording_to_directory, DhfsTime, MemorySource, DPT_ENTRIES_OFFSET, DPT_MARKER, DPT_TERMINATOR, MAGIC, SINGLE_PARTITION_SUPERBLOCK_OFFSET};
use std::{fs, path::Path};

fn stamp(text: &str) -> DhfsTime {
    let digits: Vec<u16> = text.split(['-', '_', ' ', ':']).map(|part| part.parse().expect("number")).collect();
    DhfsTime { year: digits[0], month: digits[1] as u8, day: digits[2] as u8, hour: digits[3] as u8, minute: digits[4] as u8, second: digits[5] as u8 }
}

fn put(image: &mut [u8], offset: usize, bytes: &[u8]) { image[offset..offset + bytes.len()].copy_from_slice(bytes); }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let region = fs::read(&args[1]).expect("region file");
    let trim: usize = args[2].parse().expect("fragment offset");
    let (begin, end) = (stamp(&args[3]), stamp(&args[4]));
    let out_dir = Path::new(&args[5]);
    const BLOCK: usize = 4096;
    const VIDEO_BLOCKS: usize = 64;
    let fragment_blocks = ((trim + region.len() + BLOCK - 1) / BLOCK) as u32;
    let fragment = fragment_blocks as usize * BLOCK;
    let mut image = vec![0xff_u8; VIDEO_BLOCKS * BLOCK + 2 * fragment];
    image[..VIDEO_BLOCKS * BLOCK].fill(0);
    put(&mut image, 0, MAGIC);
    put(&mut image, 0x3c00, DPT_MARKER);
    put(&mut image, 0x3c00 + DPT_ENTRIES_OFFSET as usize, &DPT_TERMINATOR);
    let sb = 0x3c00 + SINGLE_PARTITION_SUPERBLOCK_OFFSET as usize;
    put(&mut image, sb + 0x2c, &(BLOCK as u32).to_le_bytes());
    put(&mut image, sb + 0x30, &fragment_blocks.to_le_bytes());
    put(&mut image, sb + 0x44, &32_u32.to_le_bytes());
    put(&mut image, sb + 0x48, &(VIDEO_BLOCKS as u32).to_le_bytes());
    put(&mut image, sb + 0x4c, &2_u32.to_le_bytes());
    let table = 32 * BLOCK;
    let mut descriptor = [0_u8; 32];
    descriptor[0] = 1; descriptor[1] = b'0';
    descriptor[4..8].copy_from_slice(&begin.encode().to_le_bytes());
    descriptor[8..12].copy_from_slice(&end.encode().to_le_bytes());
    descriptor[16..20].copy_from_slice(&fragment_blocks.to_le_bytes());
    descriptor[24..28].copy_from_slice(&1_u32.to_le_bytes());
    put(&mut image, table + 32, &descriptor);
    let video = VIDEO_BLOCKS * BLOCK + fragment; // fragment index 1
    image[video..video + trim].fill(0x20);
    put(&mut image, video + trim, &region);
    let mut source = MemorySource(image);
    let catalog = catalog(&mut source).expect("catalog");
    let recording = &catalog.recordings[0];
    fs::create_dir_all(out_dir).expect("out dir");
    let clip = extract_recording_to_directory(&mut source, &catalog.volume, recording, out_dir, "replay").expect("extract");
    println!("{}", serde_json::to_string_pretty(&clip).expect("json"));
}
