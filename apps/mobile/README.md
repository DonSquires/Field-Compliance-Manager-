# Field Compliance Manager Mobile

Expo SDK 57 mobile app for field officers and scan operators. The first mobile
slice provides secure Supabase session persistence and an explicit configuration
state. Operational modules will be added behind the same authenticated RPC, RLS,
and module-entitlement boundaries used by the web application.

The first operational slice is a vehicle scan screen. It captures camera or
gallery evidence, records a foreground GPS fix, and submits through the same
governed `process-officer-scan` edge function used by the web app. Network
failures are stored in a durable local queue and replayed by the officer from
the scan screen. Server validation, authorization, and evidence errors remain
visible rather than being queued.

The scan screen also has a persistent safety bar. Officers can record a
foreground GPS-backed check-in or explicitly confirm an SOS. Both actions check
their database responses before showing confirmation. The mobile app does not
does not run man-down detection or client-side escalation timing; those remain
server-owned or future mobile capability. While the app is open, the safety bar
records a two-minute GPS heartbeat through the canonical
`record_officer_breadcrumb` RPC and keeps unconfirmed events in a durable local
queue for retry. During an active shift, the officer can explicitly enable
background tracking; the native task uses that same RPC and durable queue.

The profile and active-assignment hook remains available for the next mobile
home/roster slice. Local operational-data caching, background GPS/welfare,
notifications, jobs, and full offline compliance remain planned work.

## Local Development

1. Copy `.env.example` to `.env.local` and supply the public Supabase URL and
   anon key. Do not add service-role or deployment credentials.
2. Run `npm install` from this directory.
3. Run `npm start` and open the development build on an Android device or
   emulator.

## Android Delivery

EAS Build provides signed Android delivery without committing signing material:

1. Install and authenticate the EAS CLI: `npx eas-cli@latest login`.
2. Bind this app to the organization/project once: `npx eas-cli@latest init`.
   This writes the real EAS project ID to `app.json`; review that change before
   committing it.
3. Create an internal testing APK: `npx eas-cli@latest build --platform android --profile preview`.
4. Create a Play Store bundle: `npx eas-cli@latest build --platform android --profile production`.

`preview` creates an installable APK for controlled field testing. `production`
creates an Android App Bundle for Google Play. Keep Android signing credentials
in EAS or the protected hPanel secret store, never in the repository, web app,
or Builder worker.

## Verification

Run `npx tsc --noEmit -p tsconfig.json` before submitting a mobile change. Build
profiles are defined in `eas.json` and should remain limited to development,
preview APK, and production App Bundle outputs.