//! The decoder FCM Desktop V2 installs on demand, and the pure pieces around it: which build is trusted,
//! how ffmpeg is asked for a filmstrip or a preview rendition, and how its output is read back. Spawning
//! and downloading live in the Tauri layer; everything here is testable without Windows or a binary.
//!
//! Licence note: the pinned build is BtbN/FFmpeg-Builds `win64-lgpl` (FFmpeg configured without GPL
//! components). FCM runs it as a separate process and ships the licence text alongside; FCM itself is not
//! a derivative work. Changing the build means changing the hash here, deliberately.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub mod mp4;
pub mod tapo;

pub const FFMPEG_VERSION: &str = "8.1.2-c573a95381";
pub const FFMPEG_SHA256: &str = "56f015b477f6fc7923409bb63217d2ee7b2b8d236c599ba94e1cf72220548e8c";
pub const FFMPEG_BYTES: u64 = 132_239_360;
pub const LICENSE_SHA256: &str = "da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768";
pub const RELEASE_BASE: &str = "https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/desktop-releases/tools/ffmpeg";
pub const LICENCE_LABEL: &str = "FFmpeg 8.1.2 (LGPL configuration, BtbN/FFmpeg-Builds) — source: https://ffmpeg.org";

pub fn ffmpeg_url() -> String { format!("{RELEASE_BASE}/{FFMPEG_VERSION}/ffmpeg.exe") }
pub fn licence_url() -> String { format!("{RELEASE_BASE}/{FFMPEG_VERSION}/LICENSE.txt") }

/// Where the sidecar lives under the app's local data directory: one folder per pinned version, so an
/// upgrade never overwrites a binary another version verified.
pub fn install_dir(app_local_data: &Path) -> std::path::PathBuf { app_local_data.join("tools").join(format!("ffmpeg-{FFMPEG_VERSION}")) }
pub fn ffmpeg_path(app_local_data: &Path) -> std::path::PathBuf { install_dir(app_local_data).join("ffmpeg.exe") }
pub fn licence_path(app_local_data: &Path) -> std::path::PathBuf { install_dir(app_local_data).join("LICENSE.txt") }

/// SHA-256 of a stream, streamed (the binary is 132 MB).
pub fn sha256_of(reader: &mut dyn Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderStatus {
    pub installed: bool,
    pub version: String,
    pub path: Option<String>,
    pub licence: String,
    pub licence_url: String,
    pub download_bytes: u64,
    /// Set when a file is present but does not match the pinned hash: it is not used.
    pub rejected_reason: Option<String>,
}

/// How many key frames to skip between filmstrip thumbnails so `count` of them span the recording.
pub fn filmstrip_stride(key_frames: u32, count: u32) -> u32 {
    if count == 0 { return 1; }
    (key_frames / count).max(1)
}

/// Which key frames become thumbnails: every `n`th one (when the key-frame count is known, as for an `-r2`
/// extraction) or one every `seconds` (when only the duration is known, as for an ordinary video file).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilmstripPlan { Stride(u32), Interval(f64) }

/// The plan for a file: a known key-frame count wins; otherwise spread `count` thumbnails over the duration.
pub fn filmstrip_plan(key_frames: u32, duration_seconds: Option<f64>, count: u32) -> FilmstripPlan {
    match duration_seconds {
        Some(seconds) if key_frames == 0 && seconds > 0.0 => FilmstripPlan::Interval((seconds / count.max(1) as f64).max(0.5)),
        _ => FilmstripPlan::Stride(filmstrip_stride(key_frames, count)),
    }
}

/// ffmpeg arguments for a filmstrip: decode key frames only, keep the planned ones, log each kept frame's
/// time with `showinfo`, scale to a thumbnail, write numbered JPEGs into `output_pattern` (e.g. `dir/t-%02d.jpg`).
pub fn filmstrip_args(input: &str, output_pattern: &str, plan: FilmstripPlan, count: u32) -> Vec<String> {
    let select = match plan {
        FilmstripPlan::Stride(stride) => format!("select=not(mod(n\\,{}))", stride.max(1)),
        // Key frames only reach the filter, so this keeps the first key frame at or after each interval.
        FilmstripPlan::Interval(seconds) => format!("select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,{seconds:.3})"),
    };
    vec![
        "-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "info".into(),
        "-fflags".into(), "+genpts".into(), "-skip_frame".into(), "nokey".into(),
        "-i".into(), input.into(),
        "-map".into(), "0:v:0".into(),
        "-vf".into(), format!("{select},showinfo,scale=320:-2"),
        "-fps_mode".into(), "vfr".into(), "-frames:v".into(), count.to_string(),
        "-q:v".into(), "5".into(), "-f".into(), "image2".into(), "-y".into(), output_pattern.into(),
    ]
}

/// Seconds since the first kept frame, one per `showinfo` line, in output order.
pub fn parse_showinfo_times(stderr: &str) -> Vec<f64> {
    let mut times: Vec<f64> = stderr.lines()
        .filter(|line| line.contains("showinfo"))
        .filter_map(|line| line.split("pts_time:").nth(1))
        .filter_map(|rest| rest.split_whitespace().next())
        .filter_map(|token| token.parse::<f64>().ok())
        .collect();
    if let Some(first) = times.first().copied() { for time in &mut times { *time -= first; } }
    times
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewEncoder { Nvenc, Software }

/// ffmpeg arguments for the 480p H.264 viewing rendition. A viewing aid only: never uploaded, never evidence.
pub fn preview_args(input: &str, output: &str, encoder: PreviewEncoder) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(),
        "-fflags".into(), "+genpts".into(), "-i".into(), input.into(),
        "-map".into(), "0:v:0".into(), "-vf".into(), "scale=-2:480".into(),
    ];
    match encoder {
        PreviewEncoder::Nvenc => args.extend(["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "28", "-b:v", "0"].map(String::from)),
        PreviewEncoder::Software => args.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"].map(String::from)),
    }
    args.extend(["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", output].map(String::from));
    args
}

/// A stderr that means "this encoder is not available here", so software encoding should be tried.
pub fn encoder_unavailable(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    ["unknown encoder", "cannot load nvcuda", "no capable devices", "cuda_error", "driver does not support", "no nvenc capable"]
        .iter().any(|needle| text.contains(needle))
}

/// How an extracted recording becomes a playable `.mp4` for the operator's own use (the `.dav` stays the evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mp4Mode {
    /// Frames copied untouched into an MP4 container: exact, fast, but HEVC will not play on a stock Windows install.
    StreamCopy,
    /// Full-resolution H.264 re-encode so the file plays anywhere.
    H264(PreviewEncoder),
}

/// The first MP4 mode to try for a stream's codec: H.264 sources are copied; everything else is re-encoded.
pub fn mp4_mode_for(codec: &str) -> Mp4Mode {
    if codec.to_ascii_lowercase().contains("h264") { Mp4Mode::StreamCopy } else { Mp4Mode::H264(PreviewEncoder::Nvenc) }
}

/// ffmpeg arguments for the MP4 export. Video only: Dahua audio (G.711) has no place in MP4 and is not evidence.
pub fn mp4_args(input: &str, output: &str, mode: Mp4Mode) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(),
        "-fflags".into(), "+genpts".into(), "-i".into(), input.into(), "-map".into(), "0:v:0".into(),
    ];
    match mode {
        Mp4Mode::StreamCopy => args.extend(["-c:v", "copy"].map(String::from)),
        Mp4Mode::H264(PreviewEncoder::Nvenc) => args.extend(["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"].map(String::from)),
        Mp4Mode::H264(PreviewEncoder::Software) => args.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p"].map(String::from)),
    }
    args.extend(["-movflags", "+faststart", "-y", output].map(String::from));
    args
}

/// What `ffmpeg -i <file>` reports about a video file, read from its stderr banner.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub duration_seconds: Option<f64>,
    /// `creation_time` from the container, when the recorder wrote one (ISO 8601, usually UTC).
    pub creation_time: Option<String>,
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Arguments that make ffmpeg print the banner for `input` and exit (no output file is asked for).
pub fn probe_args(input: &str) -> Vec<String> { vec!["-hide_banner".into(), "-nostdin".into(), "-i".into(), input.into()] }

pub fn parse_media_probe(stderr: &str) -> MediaProbe {
    let mut probe = MediaProbe::default();
    for line in stderr.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Duration:") {
            let clock = rest.trim().split(',').next().unwrap_or("").trim();
            let parts: Vec<&str> = clock.split(':').collect();
            if parts.len() == 3 {
                if let (Ok(h), Ok(m), Ok(s)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>(), parts[2].parse::<f64>()) { probe.duration_seconds = Some(h * 3600.0 + m * 60.0 + s); }
            }
        } else if let Some(rest) = trimmed.strip_prefix("creation_time") {
            if probe.creation_time.is_none() { if let Some(value) = rest.split(':').skip(1).collect::<Vec<_>>().join(":").trim().split_whitespace().next() { probe.creation_time = Some(value.to_string()); } }
        } else if trimmed.starts_with("Stream #") && trimmed.contains("Video:") && probe.codec.is_none() {
            let after = trimmed.split("Video:").nth(1).unwrap_or("");
            probe.codec = after.split(|c: char| c == ' ' || c == ',' || c == '(').find(|token| !token.is_empty()).map(|token| token.to_string());
            for token in after.split(|c: char| c == ',' || c == ' ') {
                let token = token.trim();
                if let Some((w, h)) = token.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) { if w >= 16 && h >= 16 { probe.width = Some(w); probe.height = Some(h); break; } }
                }
            }
        }
    }
    probe
}

const ISO_BMFF_BOXES: [&[u8; 4]; 11] = [b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot", b"styp", b"sidx", b"moof", b"uuid"];
const ASF_HEADER_GUID: [u8; 16] = [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C];

/// The container the first bytes of a file announce, without running the decoder. `None` means no known
/// signature — not proof that the file holds nothing.
pub fn container_signature(head: &[u8]) -> Option<&'static str> {
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"AVI " { return Some("avi"); }
    if head.len() >= 4 && head[0..4] == [0x1A, 0x45, 0xDF, 0xA3] { return Some("matroska"); }
    if head.len() >= 4 && &head[0..4] == b"DHAV" { return Some("dhav"); }
    if head.len() >= 3 && &head[0..3] == b"FLV" { return Some("flv"); }
    if head.len() >= 16 && head[0..16] == ASF_HEADER_GUID { return Some("asf"); }
    if head.len() >= 8 && ISO_BMFF_BOXES.iter().any(|box_type| &head[4..8] == *box_type) { return Some("mp4"); }
    if head.len() >= 4 && head[0..4] == [0x00, 0x00, 0x01, 0xBA] { return Some("mpeg_ps"); }
    if head.len() >= 4 && (head[0..4] == [0x00, 0x00, 0x00, 0x01] || head[0..3] == [0x00, 0x00, 0x01]) { return Some("annex_b"); }
    if head.len() > 376 && head[0] == 0x47 && head[188] == 0x47 && head[376] == 0x47 { return Some("mpeg_ts"); }
    if head.len() > 388 && head[4] == 0x47 && head[196] == 0x47 && head[388] == 0x47 { return Some("mpeg_ts"); }
    None
}

/// True when every sampled block is filler: one repeated byte (0x00 / 0xFF — an unwritten or erased slot) or a
/// short repeating pattern (period ≤ 256 bytes — the sequence a recorder writes when it pre-formats a slot;
/// Tapo fills with `7d 82 87 8c …` stepping by 5, alternating with zero blocks). Compressed video is never
/// periodic like that. The first 64 bytes of each block are ignored so a short header before the pattern does
/// not hide it. Callers sample several offsets so a recording whose header alone is zeroed is not mistaken.
pub fn is_fill(samples: &[&[u8]]) -> bool {
    const SKIP: usize = 64;
    if samples.is_empty() || samples.iter().any(|sample| sample.len() < SKIP + 512) { return false; }
    samples.iter().all(|sample| {
        let body = &sample[SKIP..];
        (1..=256).any(|period| body.iter().zip(body[period..].iter()).all(|(a, b)| a == b))
    })
}

/// Kept for callers that only want the strict meaning: one filler byte throughout.
pub fn is_blank(samples: &[&[u8]]) -> bool {
    let mut filler: Option<u8> = None;
    for &byte in samples.iter().flat_map(|sample| sample.iter()) {
        match filler {
            None if byte == 0x00 || byte == 0xFF => filler = Some(byte),
            None => return false,
            Some(value) if byte != value => return false,
            Some(_) => {}
        }
    }
    filler.is_some()
}

/// A recorder's own placeholder name for a slot it pre-allocated but has not recorded into. TP-Link Tapo
/// cameras fill a card with 256 MB `xxxxxxxx_000000_tp00012.mp4` slots and rename one to its start time
/// (`20260911_143156_tp00000.mp4`) only when a recording is written into it. Whatever bytes such a slot
/// still holds are a previous occupant's leftovers, not a recording the camera stands behind.
pub fn is_unwritten_slot_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with("xxxxxxxx_000000_tp") && lower.ends_with(".mp4")
}

/// ffmpeg arguments for the list's thumbnail: the first key frame, decoded alone, as one small JPEG.
pub fn thumbnail_args(input: &str, output: &str) -> Vec<String> {
    [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-fflags", "+genpts", "-skip_frame", "nokey",
        "-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=192:-2", "-q:v", "6",
        "-f", "image2", "-update", "1", "-y", output,
    ].map(String::from).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_paths_are_pinned_to_the_version() {
        assert!(ffmpeg_url().ends_with("/tools/ffmpeg/8.1.2-c573a95381/ffmpeg.exe"));
        assert!(licence_url().ends_with("/8.1.2-c573a95381/LICENSE.txt"));
        assert_eq!(ffmpeg_path(Path::new("/data")), Path::new("/data/tools/ffmpeg-8.1.2-c573a95381/ffmpeg.exe"));
        assert_eq!(FFMPEG_SHA256.len(), 64);
    }

    #[test]
    fn filmstrip_stride_spreads_thumbnails_over_the_key_frames() {
        assert_eq!(filmstrip_stride(120, 12), 10);
        assert_eq!(filmstrip_stride(5, 12), 1);
        assert_eq!(filmstrip_stride(0, 12), 1);
        assert_eq!(filmstrip_stride(100, 0), 1);
    }

    #[test]
    fn filmstrip_args_select_every_nth_key_frame_and_log_times() {
        let args = filmstrip_args("C:\\clip.dav", "C:\\out\\t-%02d.jpg", FilmstripPlan::Stride(10), 12);
        assert_eq!(args.iter().position(|a| a == "-skip_frame").map(|i| args[i + 1].as_str()), Some("nokey"));
        assert_eq!(args.iter().position(|a| a == "-vf").map(|i| args[i + 1].as_str()), Some("select=not(mod(n\\,10)),showinfo,scale=320:-2"));
        assert_eq!(args.iter().position(|a| a == "-frames:v").map(|i| args[i + 1].as_str()), Some("12"));
        assert_eq!(args.last().map(String::as_str), Some("C:\\out\\t-%02d.jpg"));
        assert!(args.contains(&"-nostdin".to_string()));
    }

    #[test]
    fn filmstrip_plan_uses_time_intervals_when_only_the_duration_is_known() {
        assert_eq!(filmstrip_plan(120, Some(600.0), 12), FilmstripPlan::Stride(10));
        assert_eq!(filmstrip_plan(0, Some(240.0), 12), FilmstripPlan::Interval(20.0));
        assert_eq!(filmstrip_plan(0, Some(2.0), 12), FilmstripPlan::Interval(0.5));
        assert_eq!(filmstrip_plan(0, None, 12), FilmstripPlan::Stride(1));
        let args = filmstrip_args("a.mp4", "t-%02d.jpg", FilmstripPlan::Interval(20.0), 12);
        assert_eq!(args.iter().position(|a| a == "-vf").map(|i| args[i + 1].as_str()), Some("select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,20.000),showinfo,scale=320:-2"));
    }

    #[test]
    fn mp4_export_copies_h264_and_re_encodes_everything_else() {
        assert_eq!(mp4_mode_for("dhav/h264"), Mp4Mode::StreamCopy);
        assert_eq!(mp4_mode_for("dhav/hevc"), Mp4Mode::H264(PreviewEncoder::Nvenc));
        assert_eq!(mp4_mode_for("unknown"), Mp4Mode::H264(PreviewEncoder::Nvenc));
        let copy = mp4_args("in.dav", "out.mp4", Mp4Mode::StreamCopy);
        assert!(copy.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(!copy.iter().any(|a| a.starts_with("scale=")));
        let soft = mp4_args("in.dav", "out.mp4", Mp4Mode::H264(PreviewEncoder::Software));
        assert!(soft.windows(2).any(|w| w == ["-c:v", "libx264"]));
        for args in [&copy, &soft] {
            assert!(args.windows(2).any(|w| w == ["-map", "0:v:0"]));
            assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
            assert_eq!(args.last().map(String::as_str), Some("out.mp4"));
        }
    }

    #[test]
    fn parses_the_ffmpeg_banner_of_a_video_file() {
        let stderr = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n\
                      \x20 Metadata:\n\
                      \x20   major_brand     : isom\n\
                      \x20   creation_time   : 2026-09-11T02:31:56.000000Z\n\
                      \x20 Duration: 00:03:25.12, start: 0.000000, bitrate: 2048 kb/s\n\
                      \x20 Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 2304x1296, 2000 kb/s, 15 fps, 15 tbr, 90k tbn (default)\n\
                      \x20   Metadata:\n\
                      \x20     creation_time   : 2026-09-11T02:31:56.000000Z\n\
                      At least one output file must be specified\n";
        let probe = parse_media_probe(stderr);
        assert_eq!(probe.duration_seconds, Some(205.12));
        assert_eq!(probe.creation_time.as_deref(), Some("2026-09-11T02:31:56.000000Z"));
        assert_eq!(probe.codec.as_deref(), Some("hevc"));
        assert_eq!((probe.width, probe.height), (Some(2304), Some(1296)));
        assert_eq!(parse_media_probe("clip.dav: Invalid data found when processing input\n"), MediaProbe::default());
        assert_eq!(probe_args("x.mp4").last().map(String::as_str), Some("x.mp4"));
    }

    #[test]
    fn showinfo_times_are_relative_to_the_first_kept_frame() {
        let stderr = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  27000 pts_time:30      duration:0 fmt:yuv420p\n\
                      [dhav @ 0x2] some other line pts_time:99\n\
                      [Parsed_showinfo_1 @ 0x1] n:   1 pts:  36000 pts_time:40.5    duration:0\n\
                      [Parsed_showinfo_1 @ 0x1] n:   2 pts:  45000 pts_time:50.25 fmt:x\n";
        assert_eq!(parse_showinfo_times(stderr), vec![0.0, 10.5, 20.25]);
        assert!(parse_showinfo_times("").is_empty());
    }

    #[test]
    fn preview_args_switch_encoder_and_stay_480p_h264() {
        let nvenc = preview_args("in.dav", "out.mp4", PreviewEncoder::Nvenc);
        assert!(nvenc.windows(2).any(|w| w == ["-c:v", "h264_nvenc"]));
        let soft = preview_args("in.dav", "out.mp4", PreviewEncoder::Software);
        assert!(soft.windows(2).any(|w| w == ["-c:v", "libx264"]));
        for args in [&nvenc, &soft] {
            assert!(args.windows(2).any(|w| w == ["-vf", "scale=-2:480"]));
            assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
            assert_eq!(args.last().map(String::as_str), Some("out.mp4"));
        }
    }

    #[test]
    fn recognises_a_missing_nvenc() {
        assert!(encoder_unavailable("Unknown encoder 'h264_nvenc'"));
        assert!(encoder_unavailable("[h264_nvenc @ 0x1] Cannot load nvcuda.dll"));
        assert!(!encoder_unavailable("Invalid data found when processing input"));
    }

    #[test]
    fn hashes_a_stream() {
        let mut bytes: &[u8] = b"abc";
        assert_eq!(sha256_of(&mut bytes).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn recognises_container_signatures_from_the_first_bytes() {
        assert_eq!(container_signature(&[0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm']), Some("mp4"));
        assert_eq!(container_signature(&[0, 0, 0, 0x10, b'm', b'o', b'o', b'f', 0, 0, 0, 0]), Some("mp4"));
        assert_eq!(container_signature(b"RIFF\x00\x00\x00\x00AVI LIST"), Some("avi"));
        assert_eq!(container_signature(&[0x1A, 0x45, 0xDF, 0xA3, 0x9F]), Some("matroska"));
        assert_eq!(container_signature(b"DHAV\x00\x00\x00\x00"), Some("dhav"));
        assert_eq!(container_signature(b"FLV\x01"), Some("flv"));
        assert_eq!(container_signature(&ASF_HEADER_GUID), Some("asf"));
        assert_eq!(container_signature(&[0, 0, 1, 0xBA, 0x44]), Some("mpeg_ps"));
        assert_eq!(container_signature(&[0, 0, 0, 1, 0x67]), Some("annex_b"));
        assert_eq!(container_signature(&[0, 0, 1, 0x40]), Some("annex_b"));
        let mut ts = vec![0x11_u8; 400];
        ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
        assert_eq!(container_signature(&ts), Some("mpeg_ts"));
        assert_eq!(container_signature(&[0_u8; 512]), None);
        assert_eq!(container_signature(b"hello world, not a video"), None);
        assert_eq!(container_signature(&[]), None);
    }

    #[test]
    fn fill_means_constant_or_short_period_in_every_sampled_block() {
        let zeros = vec![0_u8; 4096];
        let ones = vec![0xFF_u8; 4096];
        // Tapo's pre-format pattern: 8 zero bytes, then bytes stepping by 5 (period 256), as read from a real slot.
        let mut tapo = vec![0_u8; 8];
        tapo.extend((0..4088_u32).map(|i| (0x7d_u8).wrapping_add(((i % 256) as u8).wrapping_mul(5))));
        let mut video = vec![0_u8; 4096];
        for (i, byte) in video.iter_mut().enumerate() { *byte = ((i as u64).wrapping_mul(2654435761) >> 7) as u8; } // pseudo-random, no short period
        let mut zeroed_header_real_body = vec![0_u8; 4096];
        zeroed_header_real_body[3000] = 0x47;
        assert!(is_fill(&[&zeros, &tapo, &zeros, &tapo]), "zero blocks alternating with the step-5 pattern");
        assert!(is_fill(&[&ones, &ones]));
        assert!(is_fill(&[&zeros, &ones]), "different fillers per block are still filler");
        assert!(!is_fill(&[&zeros, &video]), "one block of real data is enough to keep the file");
        assert!(!is_fill(&[&zeros, &zeroed_header_real_body]));
        assert!(!is_fill(&[]));
        assert!(!is_fill(&[&[0_u8; 100]]), "too short to judge");
    }

    #[test]
    fn blank_means_one_filler_byte_at_every_sampled_offset() {
        let zeros = [0_u8; 64];
        let ones = [0xFF_u8; 64];
        let mut zeroed_header_real_body = [0_u8; 64];
        zeroed_header_real_body[40] = 0x47;
        assert!(is_blank(&[&zeros, &zeros, &zeros]));
        assert!(is_blank(&[&ones, &ones]));
        assert!(!is_blank(&[&zeros, &ones]), "mixed fillers are not one pre-allocated slot");
        assert!(!is_blank(&[&zeros, &zeroed_header_real_body]), "content later in the file is not blank");
        assert!(!is_blank(&[&[0x33_u8; 8]]), "a repeated byte other than 0x00/0xFF is data");
        assert!(!is_blank(&[]));
        assert!(!is_blank(&[&[]]));
    }

    #[test]
    fn tapo_placeholder_slots_are_unwritten_by_name() {
        assert!(is_unwritten_slot_name("xxxxxxxx_000000_tp00002.mp4"));
        assert!(is_unwritten_slot_name("XXXXXXXX_000000_TP00914.MP4"));
        assert!(!is_unwritten_slot_name("20260911_143156_tp00000.mp4"));
        assert!(!is_unwritten_slot_name("xxxxxxxx_000000_tp00002.dav"));
        assert!(!is_unwritten_slot_name("Gingerbread BBQ 2 Jan 2023.mp4"));
    }

    #[test]
    fn thumbnail_args_decode_one_key_frame_into_a_single_jpeg() {
        let args = thumbnail_args("C:\\v\\a.mp4", "C:\\t\\a.jpg");
        assert!(args.windows(2).any(|w| w == ["-skip_frame", "nokey"]));
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(args.windows(2).any(|w| w == ["-update", "1"]), "a plain file name needs -update or image2 treats it as a pattern");
        assert!(args.windows(2).any(|w| w == ["-vf", "scale=192:-2"]));
        assert_eq!(args.last().map(String::as_str), Some("C:\\t\\a.jpg"));
        assert!(args.contains(&"-nostdin".to_string()));
    }
}
