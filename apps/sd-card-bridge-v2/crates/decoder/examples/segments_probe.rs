use std::fs::File;

/// `cargo run --example segments_probe -- <slot.mp4> <out dir>`: read the file's index (and the card index
/// beside it, if any), cut the clips with the system ffmpeg, and report what was planned against what was cut.
fn main() {
    let path = std::env::args().nth(1).expect("path");
    let out_dir = std::env::args().nth(2).expect("out dir");
    let mut file = File::open(&path).expect("open");
    let len = file.metadata().unwrap().len();
    let started = std::time::Instant::now();
    let mut result = fcm_decoder::mp4::analyze(&mut file, len, 3.0).expect("analyze");
    let source = std::path::Path::new(&path);
    if let (Some(dir), Some(name)) = (source.parent(), source.file_name().and_then(|n| n.to_str())) {
        let index_path = std::fs::read_dir(dir).ok().and_then(|entries| entries.flatten().map(|e| e.path()).find(|p| p.file_name().and_then(|n| n.to_str()).map(fcm_decoder::tapo::is_card_index_name).unwrap_or(false)));
        match (index_path, fcm_decoder::tapo::slot_number(name)) {
            (Some(index_path), Some(slot)) => {
                let bytes = std::fs::read(&index_path).expect("read sys01.bin");
                let index = fcm_decoder::tapo::parse_card_index(&bytes).expect("parse card index");
                let events = fcm_decoder::tapo::events_for_slot(&index, slot).expect("slot events");
                println!("card index {}: {} records, {} slots of {} MB; slot {slot} has {} events", index_path.display(), index.events.len(), index.slot_count, index.slot_size >> 20, events.len());
                match fcm_decoder::mp4::apply_card_events(&mut result, &events) { Ok(()) => println!("card index applied: clock_source={}", result.clock_source), Err(e) => println!("card index NOT applied: {e}") }
            }
            (None, _) => println!("no card index beside the file"),
            (_, None) => println!("file name carries no Tapo slot number"),
        }
    }
    println!("analyzed in {:?}: method {} · {} frames · {} key frames · {:.3}s · typical frame {:.4}s · {} segments · {} marks · clock {}",
        started.elapsed(), result.method, result.frames, result.key_frames, result.duration_seconds, result.typical_frame_seconds, result.segments.len(), result.event_marks_seconds.len(), result.clock_source);
    let show = |s: &fcm_decoder::mp4::Segment| {
        let when = s.event_start_unix.map(|t| format!("{:?}", std::time::UNIX_EPOCH + std::time::Duration::from_secs(t as u64))).unwrap_or_else(|| "-".into());
        println!("  seg {:2} {:9.3} → {:9.3} ({:4} frames, key {}, trigger +{:.1}s) event {} → {} {}", s.index, s.start_seconds, s.end_seconds, s.frames, s.starts_on_key_frame, s.trigger_offset_seconds, s.event_start_unix.unwrap_or(0), s.event_end_unix.unwrap_or(0), when);
    };
    for s in result.segments.iter().take(8) { show(s); }
    if result.segments.len() > 8 { println!("  …"); for s in result.segments.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev() { show(s); } }
    println!("  all start on key frame: {}", result.segments.iter().all(|s| s.starts_on_key_frame));
    let cuts: Vec<f64> = result.segments.iter().map(|s| s.start_seconds).collect();
    let pattern = format!("{out_dir}/slot-clip-%03d.mp4");
    let list = format!("{out_dir}/clips.csv");
    let mut audio = fcm_decoder::mp4::SplitAudio::Copy;
    let mut output = std::process::Command::new("ffmpeg").args(fcm_decoder::mp4::split_args(&path, &pattern, &list, &cuts, audio)).output().expect("ffmpeg");
    if !output.status.success() && fcm_decoder::mp4::audio_codec_refused(&String::from_utf8_lossy(&output.stderr)) {
        audio = fcm_decoder::mp4::SplitAudio::Aac;
        let cut_started = std::time::Instant::now();
        output = std::process::Command::new("ffmpeg").args(fcm_decoder::mp4::split_args(&path, &pattern, &list, &cuts, audio)).output().expect("ffmpeg");
        println!("audio re-encoded to AAC; cut took {:?}", cut_started.elapsed());
    }
    println!("ffmpeg status {} audio {:?} stderr: {}", output.status, audio, String::from_utf8_lossy(&output.stderr).trim());
    let csv = std::fs::read_to_string(&list).unwrap_or_default();
    let parsed = fcm_decoder::mp4::parse_segment_list(&csv);
    println!("segment list: {} clips", parsed.len());
    for (name, start, end) in parsed.iter().take(4) { println!("  {name} {start:.3} → {end:.3}"); }
    let mismatches: Vec<_> = parsed.iter().zip(result.segments.iter()).filter(|((_, s, _), seg)| (s - seg.start_seconds).abs() > 0.1).collect();
    println!("cut/plan start mismatches > 100 ms: {}", mismatches.len());
}
