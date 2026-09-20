//! Motion-clip boundaries inside one MP4 file, read from the container index alone.
//!
//! Some cameras write many motion-triggered recordings back to back into one file. TP-Link Tapo cards are the
//! case in hand: a 256 MB slot holds dozens of clips and the presentation clock runs on continuously across
//! them. Two marks survive in the file: (a) a proprietary `stte` table hidden inside the `free` box lists every
//! motion trigger in the video timescale — each one begins on a key frame, so it is a clean cut; (b) some (not
//! all) restarts stretch the first frame's sample duration (~0.5 s against ~0.06 s), which is the fallback
//! when there is no `stte`. Nothing in the file records how much wall-clock time passed between clips — that
//! lives in the card's own index (`tapo::CardIndex`, `sys01.bin` beside the slot files) or, failing that, only
//! in the clock burnt into the picture — so without the card index a clip's start is a *lower bound*.
//!
//! Only box headers and the `moov` are read; the media data is never touched.

use std::io::{Read, Seek, SeekFrom};

const MAX_MOOV_BYTES: u64 = 96 << 20;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub index: u32,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub frames: u32,
    /// Whether the first sample is a sync sample, i.e. the clip can be cut here without re-encoding.
    pub starts_on_key_frame: bool,
    /// Where the camera's trigger sits inside this clip (seconds from the clip's first frame): the first clip
    /// of a slot may carry a few seconds of pre-roll before its trigger; every other clip starts on it.
    pub trigger_offset_seconds: f64,
    /// The camera's own event times from the card index (Unix seconds), when the card index was available
    /// and matched this file event for event. Absent = the start is only a lower bound.
    pub event_start_unix: Option<u32>,
    pub event_end_unix: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4Segments {
    pub timescale: u32,
    pub frames: u32,
    pub key_frames: u32,
    pub duration_seconds: f64,
    pub typical_frame_seconds: f64,
    /// `event_marks` when the camera's own `stte` table gave the boundaries, `stretched_key_frame` when the
    /// sample-duration heuristic did, `single` when the file is one continuous recording.
    pub method: &'static str,
    pub segments: Vec<Segment>,
    /// Tapo's own trigger marks (`stte`), in seconds of the video timescale; empty for other recorders.
    pub event_marks_seconds: Vec<f64>,
    /// `card_index` when every segment carries the camera's own event times; `none` otherwise, with the
    /// reason a reader can show ("no sys01.bin beside the file", "card index lists 8 events, file has 76 marks").
    pub clock_source: &'static str,
    pub clock_note: Option<String>,
}

fn be32(b: &[u8]) -> u32 { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }
fn be64(b: &[u8]) -> u64 { u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) }

/// Child boxes of `buf[start..end]` as (offset, size, type, header size).
fn boxes(buf: &[u8], start: usize, end: usize) -> Vec<(usize, usize, [u8; 4], usize)> {
    let mut out = Vec::new();
    let mut o = start;
    while o + 8 <= end.min(buf.len()) {
        let mut size = be32(&buf[o..o + 4]) as usize;
        let typ = [buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]];
        let mut hs = 8;
        if size == 1 {
            if o + 16 > buf.len() { break; }
            size = be64(&buf[o + 8..o + 16]) as usize;
            hs = 16;
        } else if size == 0 { size = end - o; }
        if size < hs { break; }
        out.push((o, size, typ, hs));
        o = o.saturating_add(size);
    }
    out
}

fn find(buf: &[u8], start: usize, end: usize, path: &[&[u8; 4]]) -> Option<(usize, usize, usize)> {
    let (first, rest) = path.split_first()?;
    for (o, size, typ, hs) in boxes(buf, start, end) {
        if &typ == *first {
            return if rest.is_empty() { Some((o, size, hs)) } else { find(buf, o + hs, (o + size).min(buf.len()), rest) };
        }
    }
    None
}

/// Locate the `moov` (and a `free` box, if any) by walking top-level headers, then read them.
fn read_index<R: Read + Seek>(reader: &mut R, len: u64) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let mut offset = 0_u64;
    let mut moov: Option<Vec<u8>> = None;
    let mut free: Option<Vec<u8>> = None;
    let mut header = [0_u8; 16];
    let mut hops = 0;
    while offset + 8 <= len && hops < 64 {
        hops += 1;
        reader.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let got = read_up_to(reader, &mut header)?;
        if got < 8 { break; }
        let mut size = be32(&header[0..4]) as u64;
        let typ = &header[4..8];
        let mut hs = 8_u64;
        if size == 1 { if got < 16 { break; } size = be64(&header[8..16]); hs = 16; } else if size == 0 { size = len - offset; }
        if size < hs { return Err("malformed box size".into()); }
        if typ == b"moov" || (typ == b"free" && size <= 1 << 20) {
            if size > MAX_MOOV_BYTES { return Err(format!("the file index is {} MB, larger than expected", size >> 20)); }
            let mut body = vec![0_u8; size as usize];
            reader.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let got = read_up_to(reader, &mut body)?;
            body.truncate(got);
            if typ == b"moov" { moov = Some(body); } else { free = Some(body); }
        }
        if typ == b"ftyp" && offset == 0 { /* fine */ }
        if offset == 0 && typ != b"ftyp" && typ != b"moov" && typ != b"free" && typ != b"mdat" && typ != b"wide" && typ != b"skip" {
            return Err("not an ISO base media file".into());
        }
        offset = offset.saturating_add(size);
    }
    Ok((moov.ok_or("no moov box found (not an MP4, or the index was never written)")?, free))
}

fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, String> {
    let mut done = 0;
    while done < buf.len() {
        match reader.read(&mut buf[done..]) { Ok(0) => break, Ok(n) => done += n, Err(e) => return Err(e.to_string()) }
    }
    Ok(done)
}

/// Tapo's `stte` trigger table: a box hidden inside `free`, `u32 version/flags`, `u32 count`, then `count`
/// big-endian `u32` timestamps in the video timescale. Uninitialised slots follow the count; they are ignored.
pub fn parse_stte_ticks(free: &[u8]) -> Vec<u64> {
    if free.len() < 8 { return Vec::new(); }
    for (o, size, typ, hs) in boxes(free, 8, free.len()) {
        if &typ != b"stte" || size < hs + 8 { continue; }
        let body = &free[o + hs..(o + size).min(free.len())];
        let count = be32(&body[4..8]) as usize;
        let mut marks: Vec<u64> = (0..count).filter_map(|i| body.get(8 + i * 4..12 + i * 4)).map(|b| be32(b) as u64).collect();
        // The table is only trustworthy while it climbs; stop at the first step backwards.
        let mut cut = marks.len();
        for i in 1..marks.len() { if marks[i] <= marks[i - 1] { cut = i; break; } }
        marks.truncate(cut);
        return marks;
    }
    Vec::new()
}

pub fn parse_stte(free: &[u8], timescale: u32) -> Vec<f64> {
    if timescale == 0 { return Vec::new(); }
    parse_stte_ticks(free).into_iter().map(|t| t as f64 / timescale as f64).collect()
}

/// Segments of the first video track. With a `stte` table whose every mark lands on a key frame, the marks are
/// the boundaries (the camera's own event list); otherwise a boundary is a sync sample (after the first) whose
/// duration is at least `stretch` times the most common frame duration.
pub fn segments_from_index(moov: &[u8], free: Option<&[u8]>, stretch: f64) -> Result<Mp4Segments, String> {
    let mut video: Option<(usize, usize, usize)> = None;
    for (o, size, typ, hs) in boxes(moov, 8, moov.len()) {
        if &typ != b"trak" { continue; }
        if let Some((ho, hsz, hh)) = find(moov, o + hs, o + size, &[b"mdia", b"hdlr"]) {
            let handler = moov.get(ho + hh + 8..ho + hh + 12);
            if handler == Some(b"vide") && hsz >= 12 { video = Some((o, size, hs)); break; }
        }
    }
    let (to, tsize, ths) = video.ok_or("no video track in the file index")?;
    let (mo, _, mh) = find(moov, to + ths, to + tsize, &[b"mdia", b"mdhd"]).ok_or("no mdhd")?;
    let version = *moov.get(mo + mh).ok_or("truncated mdhd")?;
    let timescale = if version == 0 { be32(moov.get(mo + mh + 12..mo + mh + 16).ok_or("truncated mdhd")?) } else { be32(moov.get(mo + mh + 20..mo + mh + 24).ok_or("truncated mdhd")?) };
    if timescale == 0 { return Err("video timescale is zero".into()); }
    let (so, ssize, sh) = find(moov, to + ths, to + tsize, &[b"mdia", b"minf", b"stbl", b"stts"]).ok_or("no stts")?;
    let entries = be32(moov.get(so + sh + 4..so + sh + 8).ok_or("truncated stts")?) as usize;
    let mut durations: Vec<u32> = Vec::new();
    for i in 0..entries {
        let at = so + sh + 8 + i * 8;
        if at + 8 > (so + ssize).min(moov.len()) { break; }
        let count = be32(&moov[at..at + 4]) as usize;
        let duration = be32(&moov[at + 4..at + 8]);
        if durations.len() + count > 4_000_000 { return Err("sample table too large".into()); }
        durations.extend(std::iter::repeat(duration).take(count));
    }
    if durations.is_empty() { return Err("the video track has no samples".into()); }
    let mut key_frames: Vec<u32> = Vec::new();
    if let Some((ko, ksize, kh)) = find(moov, to + ths, to + tsize, &[b"mdia", b"minf", b"stbl", b"stss"]) {
        let count = be32(moov.get(ko + kh + 4..ko + kh + 8).ok_or("truncated stss")?) as usize;
        for i in 0..count {
            let at = ko + kh + 8 + i * 4;
            if at + 4 > (ko + ksize).min(moov.len()) { break; }
            key_frames.push(be32(&moov[at..at + 4]));
        }
    }
    let all_sync = key_frames.is_empty(); // no stss means every sample is a sync sample
    let is_key = |sample_number: u32| all_sync || key_frames.binary_search(&sample_number).is_ok();
    let typical = {
        let mut sorted = durations.clone();
        sorted.sort_unstable();
        let mut best = (sorted[0], 0_usize);
        let mut run = (sorted[0], 0_usize);
        for &d in &sorted {
            if d == run.0 { run.1 += 1; } else { run = (d, 1); }
            if run.1 > best.1 { best = run; }
        }
        best.0.max(1)
    };
    // pts of every sample, in ticks (pts[i] = start of sample i; a final entry holds the total).
    let mut pts: Vec<u64> = Vec::with_capacity(durations.len() + 1);
    let mut ticks = 0_u64;
    for &d in &durations { pts.push(ticks); ticks += d as u64; }
    pts.push(ticks);
    let scale = timescale as f64;
    let marks_ticks = free.map(parse_stte_ticks).unwrap_or_default();
    let event_marks_seconds: Vec<f64> = marks_ticks.iter().map(|&t| t as f64 / scale).collect();

    // Boundary samples (0-based), always including sample 0. First choice: the camera's marks, each of which
    // must land on a key frame (to within a millisecond: the firmware rounds its ticks) — otherwise the table
    // is not describing this file and is not trusted.
    let mut boundaries: Vec<usize> = vec![0];
    let mut method = "single";
    let mut trigger_offsets: Vec<f64> = vec![0.0];
    if marks_ticks.len() >= 2 {
        let tolerance = (timescale as u64 / 1000).max(1);
        let sample_at = |t: u64| -> Option<usize> {
            let table = &pts[..durations.len()];
            let i = table.partition_point(|&p| p < t);
            let candidates = [i.checked_sub(1), (i < table.len()).then_some(i)];
            candidates.into_iter().flatten().filter(|&s| table[s].abs_diff(t) <= tolerance).min_by_key(|&s| table[s].abs_diff(t))
        };
        let mut ok = true;
        let mut chosen = vec![0_usize];
        for (i, &t) in marks_ticks.iter().enumerate() {
            let Some(s) = sample_at(t) else { ok = false; break; };
            if !is_key(s as u32 + 1) { ok = false; break; }
            if i == 0 { trigger_offsets[0] = pts[s] as f64 / scale; continue; } // pre-roll before the first trigger
            if s == 0 || s <= *chosen.last().unwrap() { ok = false; break; }
            chosen.push(s);
        }
        if ok {
            boundaries = chosen;
            method = "event_marks";
            trigger_offsets.resize(boundaries.len(), 0.0);
        }
    }
    if boundaries.len() == 1 {
        let threshold = (typical as f64 * stretch).ceil() as u64;
        for (i, &d) in durations.iter().enumerate() {
            if i > 0 && (d as u64) >= threshold && is_key(i as u32 + 1) { boundaries.push(i); }
        }
        if boundaries.len() > 1 { method = "stretched_key_frame"; }
        trigger_offsets = vec![0.0; boundaries.len()];
    }
    let mut segments = Vec::with_capacity(boundaries.len());
    for (k, &start) in boundaries.iter().enumerate() {
        let end = boundaries.get(k + 1).copied().unwrap_or(durations.len());
        segments.push(Segment {
            index: k as u32, start_seconds: pts[start] as f64 / scale, end_seconds: pts[end] as f64 / scale, frames: (end - start) as u32,
            starts_on_key_frame: is_key(start as u32 + 1), trigger_offset_seconds: trigger_offsets.get(k).copied().unwrap_or(0.0),
            event_start_unix: None, event_end_unix: None,
        });
    }
    Ok(Mp4Segments {
        timescale, frames: durations.len() as u32, key_frames: if all_sync { durations.len() as u32 } else { key_frames.len() as u32 },
        duration_seconds: ticks as f64 / scale, typical_frame_seconds: typical as f64 / scale,
        method, segments, event_marks_seconds, clock_source: "none", clock_note: None,
    })
}

/// Date every segment from the camera's own card index: event `i` of the slot is segment `i` (the segments
/// came from the same `stte` marks the camera wrote when it logged the events). Refused, with the reason, when
/// the counts differ or the boundaries did not come from the marks — a wrong date is worse than a bound.
pub fn apply_card_events(result: &mut Mp4Segments, events: &[crate::tapo::CardEvent]) -> Result<(), String> {
    if result.method != "event_marks" { return Err(format!("the file's boundaries did not come from its event marks ({}); the card index cannot be matched to them", result.method)); }
    if events.len() != result.segments.len() { return Err(format!("the card index lists {} events for this slot but the file has {} event marks", events.len(), result.segments.len())); }
    for (segment, event) in result.segments.iter_mut().zip(events) {
        segment.event_start_unix = Some(event.start_unix);
        segment.event_end_unix = Some(event.end_unix);
    }
    result.clock_source = "card_index";
    result.clock_note = None;
    Ok(())
}

/// Read a file's index and derive its motion-clip segments. `stretch` of 3.0 is the working value for the
/// fallback: Tapo stretches the first frame of a restart to ~8.7 normal frames; ordinary jitter stays under 2.
pub fn analyze<R: Read + Seek>(reader: &mut R, len: u64, stretch: f64) -> Result<Mp4Segments, String> {
    let (moov, free) = read_index(reader, len)?;
    segments_from_index(&moov, free.as_deref(), stretch)
}

/// What happens to the audio track when a file is split. Video is always copied frame for frame; MP4 cannot
/// carry some camera audio codecs (Tapo writes µ-law PCM), so those are re-encoded to AAC and said so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitAudio { Copy, Aac, None }

/// ffmpeg arguments that cut one file into clips at `cut_seconds` without re-encoding the video, each clip
/// starting on the key frame at the cut. A hair before each cut so a rounding error can never push it to the
/// next key frame; the segment muxer only ever cuts on a key frame at or after the time given. Timestamps
/// restart at zero in each clip, global metadata is dropped (the source's creation time would mis-date every
/// clip), and the muxer writes `list_path` (CSV: file,start,end) recording what was actually cut.
pub fn split_args(input: &str, output_pattern: &str, list_path: &str, cut_seconds: &[f64], audio: SplitAudio) -> Vec<String> {
    let times = cut_seconds.iter().filter(|t| **t > 0.0).map(|t| format!("{:.4}", (t - 0.02).max(0.0))).collect::<Vec<_>>().join(",");
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-i".into(), input.into()];
    match audio {
        SplitAudio::Copy => args.extend(["-map", "0", "-c", "copy"].map(String::from)),
        SplitAudio::Aac => args.extend(["-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k"].map(String::from)),
        SplitAudio::None => args.extend(["-map", "0:v:0", "-c:v", "copy", "-an"].map(String::from)),
    }
    args.extend([
        "-map_metadata", "-1", "-f", "segment", "-segment_times", &times, "-segment_format", "mp4",
        "-segment_format_options", "movflags=+faststart", "-reset_timestamps", "1",
        "-segment_list", list_path, "-segment_list_type", "csv", "-y", output_pattern,
    ].map(String::from));
    args
}

/// A stderr that means the container refused the audio codec on stream copy, so the audio must be re-encoded.
pub fn audio_codec_refused(stderr: &str) -> bool {
    stderr.contains("Could not find tag for codec") || stderr.contains("codec not currently supported in container")
}

/// One line per clip from the segment muxer's CSV list: (file name, start seconds, end seconds).
pub fn parse_segment_list(csv: &str) -> Vec<(String, f64, f64)> {
    csv.lines().filter_map(|line| {
        let mut parts = line.rsplitn(3, ',');
        let end = parts.next()?.trim().parse::<f64>().ok()?;
        let start = parts.next()?.trim().parse::<f64>().ok()?;
        let name = parts.next()?.trim();
        Some((name.to_string(), start, end))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn boxed(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(typ);
        out.extend_from_slice(body);
        out
    }
    fn full(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> { let mut body = vec![0, 0, 0, 0]; body.extend_from_slice(payload); boxed(typ, &body) }
    fn stts(entries: &[(u32, u32)]) -> Vec<u8> {
        let mut p = (entries.len() as u32).to_be_bytes().to_vec();
        for (c, d) in entries { p.extend_from_slice(&c.to_be_bytes()); p.extend_from_slice(&d.to_be_bytes()); }
        full(b"stts", &p)
    }
    fn stss(samples: &[u32]) -> Vec<u8> {
        let mut p = (samples.len() as u32).to_be_bytes().to_vec();
        for s in samples { p.extend_from_slice(&s.to_be_bytes()); }
        full(b"stss", &p)
    }
    fn mdhd(timescale: u32) -> Vec<u8> {
        let mut p = vec![0_u8; 8]; // creation, modification
        p.extend_from_slice(&timescale.to_be_bytes());
        p.extend_from_slice(&0_u32.to_be_bytes());
        p.extend_from_slice(&[0, 0, 0, 0]);
        full(b"mdhd", &p)
    }
    fn hdlr(handler: &[u8; 4]) -> Vec<u8> { let mut p = vec![0_u8; 4]; p.extend_from_slice(handler); p.extend_from_slice(&[0_u8; 13]); full(b"hdlr", &p) }
    fn video_moov(timescale: u32, stts_entries: &[(u32, u32)], keys: &[u32]) -> Vec<u8> {
        let stbl = boxed(b"stbl", &[stts(stts_entries), stss(keys)].concat());
        let minf = boxed(b"minf", &stbl);
        let mdia = boxed(b"mdia", &[mdhd(timescale), hdlr(b"vide"), minf].concat());
        let sound_mdia = boxed(b"mdia", &[mdhd(8000), hdlr(b"soun"), boxed(b"minf", &boxed(b"stbl", &stts(&[(10, 800)])))].concat());
        boxed(b"moov", &[boxed(b"trak", &sound_mdia), boxed(b"trak", &mdia)].concat())
    }

    #[test]
    fn tapo_style_stretched_key_frames_split_the_file_when_there_are_no_marks() {
        // 30-frame GOPs at 60 ms; the first frame of clips 2 and 3 is stretched to 0.52 s and is a key frame.
        let entries = [(30, 5400), (1, 46784), (59, 5400), (1, 46784), (29, 5400)];
        let keys = [1, 31, 61, 91];
        let moov = video_moov(90000, &entries, &keys);
        let result = segments_from_index(&moov, None, 3.0).unwrap();
        assert_eq!(result.method, "stretched_key_frame");
        assert_eq!(result.frames, 120);
        assert_eq!(result.key_frames, 4);
        assert!((result.typical_frame_seconds - 0.06).abs() < 1e-9);
        assert_eq!(result.segments.len(), 3);
        assert_eq!(result.segments.iter().map(|s| s.frames).collect::<Vec<_>>(), vec![30, 60, 30]);
        assert!(result.segments.iter().all(|s| s.starts_on_key_frame));
        assert!((result.segments[1].start_seconds - 1.8).abs() < 1e-9);
        assert!((result.segments[2].start_seconds - (1.8 + 46784.0 / 90000.0 + 59.0 * 0.06)).abs() < 1e-6);
        assert!((result.duration_seconds - result.segments[2].end_seconds).abs() < 1e-9);
        assert_eq!(result.clock_source, "none");
    }

    fn stte_free(marks: &[u32]) -> Vec<u8> {
        let mut body = vec![0_u8; 4];
        body.extend_from_slice(&(marks.len() as u32).to_be_bytes());
        for m in marks { body.extend_from_slice(&m.to_be_bytes()); }
        body.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]); // uninitialised tail
        boxed(b"free", &boxed(b"stte", &body))
    }

    /// The shape of a real Tapo slot, scaled down: 6 s of pre-roll (samples 0..99), the first trigger on the
    /// key frame at sample 100, a restart with a stretched key frame at sample 130, and a further trigger on
    /// the key frame at sample 160 with no stretched frame (the camera kept the encoder running).
    fn tapo_moov() -> Vec<u8> { video_moov(90000, &[(130, 5400), (1, 46784), (59, 5400)], &[1, 31, 61, 91, 101, 131, 161]) }
    const TAPO_MARKS: [u32; 3] = [100 * 5400, 130 * 5400, 130 * 5400 + 46784 + 29 * 5400];

    #[test]
    fn event_marks_win_over_stretched_frames_and_split_inside_a_continuous_run() {
        let moov = tapo_moov();
        let heuristic = segments_from_index(&moov, None, 3.0).unwrap();
        assert_eq!(heuristic.method, "stretched_key_frame");
        assert_eq!(heuristic.segments.len(), 2, "the stretched frame alone sees two clips");
        let result = segments_from_index(&moov, Some(&stte_free(&TAPO_MARKS)), 3.0).unwrap();
        assert_eq!(result.method, "event_marks");
        assert_eq!(result.segments.len(), 3, "{:?}", result.segments);
        assert_eq!(result.segments.iter().map(|s| s.frames).collect::<Vec<_>>(), vec![130, 30, 30]);
        assert!((result.segments[0].trigger_offset_seconds - 6.0).abs() < 1e-9, "pre-roll before the first trigger");
        assert_eq!(result.segments[1].trigger_offset_seconds, 0.0);
        assert!((result.segments[1].start_seconds - 7.8).abs() < 1e-9);
        assert!(result.segments.iter().all(|s| s.starts_on_key_frame));
        assert_eq!(result.event_marks_seconds.len(), 3);
        assert_eq!(result.clock_source, "none");
    }

    #[test]
    fn marks_that_do_not_land_on_key_frames_are_not_trusted() {
        let entries = [(30, 5400), (1, 46784), (59, 5400)];
        let moov = video_moov(90000, &entries, &[1, 31, 61]);
        // second mark points 7 frames into a GOP: not this file's table
        let free = stte_free(&[0, 30 * 5400 + 46784 + 7 * 5400]);
        let result = segments_from_index(&moov, Some(&free), 3.0).unwrap();
        assert_eq!(result.method, "stretched_key_frame", "falls back to the sample-duration heuristic");
        assert_eq!(result.segments.len(), 2);
    }

    #[test]
    fn card_events_date_the_segments_only_when_they_match_the_marks() {
        let mut result = segments_from_index(&tapo_moov(), Some(&stte_free(&TAPO_MARKS)), 3.0).unwrap();
        assert_eq!(result.method, "event_marks");
        let event = |i: u32, start: u32, end: u32| crate::tapo::CardEvent { slot: 0, index_in_slot: i, index_on_card: i, start_unix: start, end_unix: end, offset: 0, length: 0, kind: 4 };
        assert!(apply_card_events(&mut result, &[event(0, 1_789_093_922, 1_789_093_934)]).is_err(), "one event for three marks");
        assert_eq!(result.clock_source, "none");
        apply_card_events(&mut result, &[event(0, 1_789_093_922, 1_789_093_934), event(1, 1_789_093_962, 1_789_093_982), event(2, 1_789_094_000, 1_789_094_020)]).unwrap();
        assert_eq!(result.clock_source, "card_index");
        assert_eq!(result.segments[1].event_start_unix, Some(1_789_093_962));
        assert_eq!(result.segments[2].event_end_unix, Some(1_789_094_020));
        let mut heuristic = segments_from_index(&video_moov(90000, &[(30, 5400), (1, 46784), (29, 5400)], &[1, 31]), None, 3.0).unwrap();
        assert!(apply_card_events(&mut heuristic, &[event(0, 1_789_093_922, 1_789_093_934), event(1, 1_789_093_962, 1_789_093_982)]).is_err(), "heuristic boundaries are never dated from the index");
    }

    #[test]
    fn a_stretched_frame_that_is_not_a_key_frame_is_jitter_not_a_boundary() {
        let entries = [(30, 5400), (1, 46784), (29, 5400)];
        let moov = video_moov(90000, &entries, &[1]);
        let result = segments_from_index(&moov, None, 3.0).unwrap();
        assert_eq!(result.method, "single");
        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].frames, 60);
    }

    #[test]
    fn an_ordinary_recording_is_one_segment() {
        let moov = video_moov(30000, &[(300, 1001)], &[1, 61, 121, 181, 241]);
        let result = segments_from_index(&moov, None, 3.0).unwrap();
        assert_eq!(result.method, "single");
        assert_eq!(result.segments.len(), 1);
        assert!((result.duration_seconds - 300.0 * 1001.0 / 30000.0).abs() < 1e-9);
    }

    #[test]
    fn reads_the_index_from_the_tail_of_a_file_and_tapo_trigger_marks() {
        // Marks 0 and 30 land on key frames (samples 1 and 31): the marks are the boundaries.
        let moov = video_moov(90000, &[(30, 5400), (1, 46784), (29, 5400)], &[1, 31]);
        let mut stte_body = vec![0_u8; 4];
        stte_body.extend_from_slice(&3_u32.to_be_bytes());
        for v in [0_u32, 30 * 5400, 30 * 5400 + 46784 + 10 * 5400, 960381768, 17173264] { stte_body.extend_from_slice(&v.to_be_bytes()); }
        let free = boxed(b"free", &boxed(b"stte", &stte_body));
        let mdat = boxed(b"mdat", &[0_u8; 4096]);
        let ftyp = boxed(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41");
        let file = [ftyp, mdat, free, moov].concat();
        let len = file.len() as u64;
        let result = analyze(&mut Cursor::new(file), len, 3.0).unwrap();
        assert_eq!(result.event_marks_seconds.len(), 3, "only the counted, climbing entries are trusted");
        assert!((result.event_marks_seconds[1] - 1.8).abs() < 1e-9);
        // the third mark is not a key frame, so the table is refused and the stretched frame decides
        assert_eq!(result.method, "stretched_key_frame");
        assert_eq!(result.segments.len(), 2);
    }

    #[test]
    fn rejects_files_that_are_not_mp4() {
        let file = b"DHAV\0\0\0\0garbage".to_vec();
        let len = file.len() as u64;
        assert!(analyze(&mut Cursor::new(file), len, 3.0).is_err());
    }

    #[test]
    fn split_args_cut_a_hair_early_on_key_frames_without_re_encoding_video() {
        let args = split_args("C:\\v\\slot.mp4", "C:\\out\\slot-clip-%03d.mp4", "C:\\out\\clips.csv", &[0.0, 17.98, 114.581], SplitAudio::Copy);
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-segment_times", "17.9600,114.5610"]), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-reset_timestamps", "1"]));
        assert!(args.windows(2).any(|w| w == ["-map_metadata", "-1"]));
        assert!(args.windows(2).any(|w| w == ["-segment_list_type", "csv"]));
        assert_eq!(args.last().map(String::as_str), Some("C:\\out\\slot-clip-%03d.mp4"));
        let aac = split_args("in.mp4", "out-%03d.mp4", "list.csv", &[0.0, 5.0], SplitAudio::Aac);
        assert!(aac.windows(2).any(|w| w == ["-c:v", "copy"]) && aac.windows(2).any(|w| w == ["-c:a", "aac"]));
        let mute = split_args("in.mp4", "out-%03d.mp4", "list.csv", &[0.0, 5.0], SplitAudio::None);
        assert!(mute.contains(&"-an".to_string()) && mute.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(audio_codec_refused("[mp4 @ 0x1] Could not find tag for codec pcm_mulaw in stream #1, codec not currently supported in container"));
        assert!(!audio_codec_refused("Invalid data found when processing input"));
    }

    #[test]
    fn parses_the_segment_muxer_list() {
        let list = parse_segment_list("slot-clip-000.mp4,0.000000,17.980000\nslot-clip-001.mp4,17.980000,114.581000\nbad line\n");
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].0, "slot-clip-001.mp4");
        assert!((list[1].1 - 17.98).abs() < 1e-9 && (list[1].2 - 114.581).abs() < 1e-9);
    }
}
