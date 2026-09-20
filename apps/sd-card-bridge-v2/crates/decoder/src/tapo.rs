//! TP-Link Tapo's card-level event index, `sys01.bin`, written beside the `*_tpNNNNN.mp4` slot files.
//!
//! Read from a real card (2026-09-20, two recorded slots, verified against the clock burnt into the picture
//! to the second): big-endian throughout; a 1,856-byte header (`u32 @0x2c` = record size 80, `u32 @0x30` =
//! slot size 256 MiB, `u32 @0x34` = slot count, `u32 @0x4c` = header size); then 80-byte records, one per
//! motion event, in the order the camera wrote them:
//!
//! ```text
//! w0 0 · w1 byte offset of the event's data in the slot · w2 its length · w3 w4 0 · w5 slot number ·
//! w6 event index within the slot · w7 event index across the card · w8 start (Unix seconds) ·
//! w9 end (Unix seconds) · w10 checksum · w11 w12 0 · w13 kind (4 = motion) · w14..w19 0
//! ```
//!
//! Unused records read `0x77770000 …`. The slot number is the `tpNNNNN` in the file name. Event `i` of a
//! slot is the `i`th mark of that slot file's own `stte` table, so the two together date every clip; the
//! slot's first event may be preceded by a few seconds of pre-roll (the first `stte` mark says how much).

const RECORD: usize = 80;
const PLACEHOLDER: u32 = 0x7777_0000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardEvent {
    pub slot: u32,
    pub index_in_slot: u32,
    pub index_on_card: u32,
    pub start_unix: u32,
    pub end_unix: u32,
    pub offset: u32,
    pub length: u32,
    pub kind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardIndex {
    pub record_size: u32,
    pub slot_size: u32,
    pub slot_count: u32,
    pub events: Vec<CardEvent>,
}

fn be32(b: &[u8]) -> u32 { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }

/// True when a folder listing looks like a Tapo card: the index file is present. Case-insensitive because the
/// card is FAT and Windows may show either case.
pub fn is_card_index_name(name: &str) -> bool { name.eq_ignore_ascii_case("sys01.bin") }

/// The slot number in a Tapo slot file name: `20260911_143156_tp00000.mp4` → 0, `xxxxxxxx_000000_tp00913.mp4` → 913.
pub fn slot_number(file_name: &str) -> Option<u32> {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".mp4")?;
    let at = stem.rfind("_tp")?;
    let digits = &stem[at + 3..];
    if digits.is_empty() || digits.len() > 6 || !digits.bytes().all(|b| b.is_ascii_digit()) { return None; }
    digits.parse().ok()
}

/// Parse `sys01.bin`. Refuses anything whose header does not describe 80-byte records, and stops at the first
/// placeholder or empty record. Years outside 2000–2100 or an end before its start invalidate the whole index —
/// a half-understood index is worse than none.
pub fn parse_card_index(bytes: &[u8]) -> Result<CardIndex, String> {
    if bytes.len() < 0x60 { return Err("sys01.bin is too short to hold its header".into()); }
    let record_size = be32(&bytes[0x2c..0x30]);
    let slot_size = be32(&bytes[0x30..0x34]);
    let slot_count = be32(&bytes[0x34..0x38]);
    let header_size = be32(&bytes[0x4c..0x50]) as usize;
    if record_size as usize != RECORD { return Err(format!("sys01.bin describes {record_size}-byte records; only the 80-byte layout is understood")); }
    if header_size < 0x50 || header_size > bytes.len() { return Err("sys01.bin header size is out of range".into()); }
    let mut events = Vec::new();
    let mut o = header_size;
    while o + RECORD <= bytes.len() {
        let w: Vec<u32> = (0..20).map(|i| be32(&bytes[o + i * 4..o + i * 4 + 4])).collect();
        if w[0] == PLACEHOLDER || w.iter().all(|&v| v == 0) { break; }
        let (start, end) = (w[8], w[9]);
        // 2000-01-01 .. 2100-01-01
        if !(946_684_800..4_102_444_800).contains(&start) || end < start || end - start > 86_400 {
            return Err(format!("sys01.bin record {} carries an implausible time ({start}..{end}); the index is not trusted", events.len()));
        }
        events.push(CardEvent { slot: w[5], index_in_slot: w[6], index_on_card: w[7], start_unix: start, end_unix: end, offset: w[1], length: w[2], kind: w[13] });
        o += RECORD;
        if events.len() > 1_000_000 { return Err("sys01.bin lists more events than a card can hold".into()); }
    }
    Ok(CardIndex { record_size, slot_size, slot_count, events })
}

/// The events of one slot, in the camera's order. Checks the per-slot indices run 0, 1, 2 … so a corrupt or
/// half-written table is refused rather than mis-dated.
pub fn events_for_slot(index: &CardIndex, slot: u32) -> Result<Vec<CardEvent>, String> {
    let events: Vec<CardEvent> = index.events.iter().filter(|e| e.slot == slot).cloned().collect();
    for (i, event) in events.iter().enumerate() {
        if event.index_in_slot != i as u32 { return Err(format!("the card index for slot {slot} is out of order at event {i}")); }
        if i > 0 && event.start_unix < events[i - 1].end_unix { return Err(format!("the card index for slot {slot} runs backwards at event {i}")); }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(slot: u32, idx: u32, global: u32, start: u32, end: u32) -> Vec<u8> {
        let words = [0, 4096 * idx, 4096, 0, 0, slot, idx, global, start, end, 0xdead_beef, 0, 0, 4, 0, 0, 0, 0, 0, 0];
        words.iter().flat_map(|w| w.to_be_bytes()).collect()
    }
    fn header() -> Vec<u8> {
        let mut h = vec![0_u8; 1856];
        h[0x2c..0x30].copy_from_slice(&80_u32.to_be_bytes());
        h[0x30..0x34].copy_from_slice(&0x1000_0000_u32.to_be_bytes());
        h[0x34..0x38].copy_from_slice(&915_u32.to_be_bytes());
        h[0x4c..0x50].copy_from_slice(&1856_u32.to_be_bytes());
        h
    }

    #[test]
    fn slot_numbers_come_from_the_file_name() {
        assert_eq!(slot_number("20260911_143156_tp00000.mp4"), Some(0));
        assert_eq!(slot_number("20260915_141819_tp00001.MP4"), Some(1));
        assert_eq!(slot_number("xxxxxxxx_000000_tp00913.mp4"), Some(913));
        assert_eq!(slot_number("Gingerbread BBQ 2 Jan 2023.mp4"), None);
        assert_eq!(slot_number("clip_tp.mp4"), None);
        assert_eq!(slot_number("20260911_143156_tp00000.dav"), None);
        assert!(is_card_index_name("SYS01.BIN") && !is_card_index_name("sys00.bin"));
    }

    #[test]
    fn parses_records_until_the_placeholder_and_groups_by_slot() {
        let mut bytes = header();
        bytes.extend(record(0, 0, 0, 1_789_093_922, 1_789_093_934));
        bytes.extend(record(0, 1, 1, 1_789_093_962, 1_789_093_982));
        bytes.extend(record(1, 0, 2, 1_789_438_699, 1_789_438_711));
        let mut placeholder = vec![0_u8; 80];
        placeholder[0..4].copy_from_slice(&PLACEHOLDER.to_be_bytes());
        bytes.extend(placeholder);
        bytes.extend(record(0, 9, 9, 1_789_000_000, 1_789_000_001)); // after the placeholder: never read
        let index = parse_card_index(&bytes).unwrap();
        assert_eq!((index.record_size, index.slot_size, index.slot_count), (80, 0x1000_0000, 915));
        assert_eq!(index.events.len(), 3);
        let slot0 = events_for_slot(&index, 0).unwrap();
        assert_eq!(slot0.len(), 2);
        assert_eq!((slot0[1].start_unix, slot0[1].end_unix, slot0[1].index_on_card), (1_789_093_962, 1_789_093_982, 1));
        assert_eq!(events_for_slot(&index, 1).unwrap().len(), 1);
        assert!(events_for_slot(&index, 7).unwrap().is_empty());
    }

    #[test]
    fn refuses_layouts_and_times_it_does_not_understand() {
        let mut bad_size = header();
        bad_size[0x2c..0x30].copy_from_slice(&96_u32.to_be_bytes());
        assert!(parse_card_index(&bad_size).is_err());
        let mut bad_time = header();
        bad_time.extend(record(0, 0, 0, 12_345, 12_350));
        assert!(parse_card_index(&bad_time).is_err());
        let mut backwards = header();
        backwards.extend(record(0, 0, 0, 1_789_093_922, 1_789_093_934));
        backwards.extend(record(0, 1, 1, 1_789_093_900, 1_789_093_910));
        let index = parse_card_index(&backwards).unwrap();
        assert!(events_for_slot(&index, 0).is_err());
        let mut gap = header();
        gap.extend(record(0, 0, 0, 1_789_093_922, 1_789_093_934));
        gap.extend(record(0, 2, 2, 1_789_093_962, 1_789_093_982));
        assert!(events_for_slot(&parse_card_index(&gap).unwrap(), 0).is_err());
        assert!(parse_card_index(&[0_u8; 16]).is_err());
    }
}
