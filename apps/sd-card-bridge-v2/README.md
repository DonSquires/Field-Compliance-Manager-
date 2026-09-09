# FCM Desktop V2 Prototype

Desktop V2 is an isolated prototype beside the working `apps/sd-card-bridge` application.

## Purpose

V2 tests a clone-first evidence workflow:

1. Discover removable camera media without opening a write handle.
2. Acquire an exact image to a separate destination.
3. Hash source and image bytes and verify equality.
4. Inspect the image as a virtual source.
5. Run multiple decoder adapters without rejecting unknown layouts.

The prototype does not replace or modify Desktop V1.

## Native commands

- `discover_read_only_devices`
- `acquire_read_only_device_image`
- `inspect_acquisition_image`

The current native acquisition implementation targets Windows physical devices. The UI intentionally presents unknown adapter results as investigation candidates rather than successful decoding.

## Run

```bash
npm install
npm run dev
```

For a Tauri build, install the platform prerequisites and run `npm run tauri dev`.
