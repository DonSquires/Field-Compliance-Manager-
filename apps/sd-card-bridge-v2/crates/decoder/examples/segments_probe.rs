use std::fs::File;


fn main() {
    let path = std::env::args().nth(1).expect("path");
    let out_dir = std::env::args().nth(2).expect("out dir");
    let mut file = File::open(&path).expect("open");
    let len = file.metadata().unwrap().len();
    let started = std::time::Instant::now();
    let result = fcm_decoder::mp4::analyze(&mut file, len, 3.0).expect("analyze");
    println!("analyzed in {:?}: method {} · {} frames · {} key frames · {:.3}s · typical frame {:.4}s · {} segments · {} trigger marks",
        started.elapsed(), result.method, result.frames, result.key_frames, result.duration_seconds, result.typical_frame_seconds, result.segments.len(), result.event_marks_seconds.len());
    for s in result.segments.iter().take(5) { println!("  seg {:2} {:9.3} → {:9.3} ({:4} frames, key start {})", s.index, s.start_seconds, s.end_seconds, s.frames, s.starts_on_key_frame); }
    println!("  … all start on key frame: {}", result.segments.iter().all(|s| s.starts_on_key_frame));
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
    for (name, start, end) in parsed.iter().take(5) { println!("  {name} {start:.3} → {end:.3}"); }
    let mismatches: Vec<_> = parsed.iter().zip(result.segments.iter()).filter(|((_, s, _), seg)| (s - seg.start_seconds).abs() > 0.03).collect();
    println!("cut/plan mismatches > 30 ms: {}", mismatches.len());
}
