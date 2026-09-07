# Third-party notices

## DHFS4.1 filesystem extraction logic

FCM Desktop includes a Rust implementation of the normal DHFS4.1 descriptor-chain extraction path based on the open-source `dhfs_extractor` project:

- Source: https://github.com/gbatmobile/dhfs_extractor
- Author: GALILEU Batista (galileu.batista@ifrn.edu.br)
- License: MIT

The FCM implementation supports read-only disk or partition images and normal recorded-video chain reconstruction. Recovery, slack carving, and destructive filesystem operations are not enabled by default.
