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

/// ffmpeg arguments for a filmstrip: decode key frames only, keep every `stride`-th, log each kept frame's
/// time with `showinfo`, scale to a thumbnail, write numbered JPEGs into `output_pattern` (e.g. `dir/t-%02d.jpg`).
pub fn filmstrip_args(input: &str, output_pattern: &str, stride: u32, count: u32) -> Vec<String> {
    vec![
        "-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "info".into(),
        "-fflags".into(), "+genpts".into(), "-skip_frame".into(), "nokey".into(),
        "-i".into(), input.into(),
        "-map".into(), "0:v:0".into(),
        "-vf".into(), format!("select=not(mod(n\\,{stride})),showinfo,scale=320:-2"),
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
        let args = filmstrip_args("C:\\clip.dav", "C:\\out\\t-%02d.jpg", 10, 12);
        assert_eq!(args.iter().position(|a| a == "-skip_frame").map(|i| args[i + 1].as_str()), Some("nokey"));
        assert_eq!(args.iter().position(|a| a == "-vf").map(|i| args[i + 1].as_str()), Some("select=not(mod(n\\,10)),showinfo,scale=320:-2"));
        assert_eq!(args.iter().position(|a| a == "-frames:v").map(|i| args[i + 1].as_str()), Some("12"));
        assert_eq!(args.last().map(String::as_str), Some("C:\\out\\t-%02d.jpg"));
        assert!(args.contains(&"-nostdin".to_string()));
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
}
