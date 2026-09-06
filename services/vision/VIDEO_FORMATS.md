# CCTV Video Compatibility

The extractor accepts local files that the installed FFmpeg/OpenCV backend can decode. Common inputs include:

- MP4: H.264/AVC, H.265/HEVC, and MPEG-4
- AVI: MJPEG and MPEG-4
- MKV: H.264/AVC and H.265/HEVC
- MOV: H.264/AVC and MPEG-4
- Other FFmpeg-supported containers and codecs

The output records the decoder backend, codec FOURCC, frame dimensions, and frame rate. Variable or unreliable decoder timestamps fall back to frame index divided by FPS. Audio tracks are ignored by motion extraction.

Unsupported or corrupt files fail without writing frame artifacts outside the requested motion windows. A deployment should validate representative camera exports before accepting a new CCTV source format.