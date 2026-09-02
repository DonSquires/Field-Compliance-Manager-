# Field Compliance Manager Mobile

Expo SDK 57 mobile app for field officers and scan operators. The first mobile
slice provides secure Supabase session persistence and an explicit configuration
state. Operational modules will be added behind the same authenticated RPC, RLS,
and module-entitlement boundaries used by the web application.

The current signed-in home loads the officer profile and only the officer's
accepted or in-progress shift that is active at the current time. It presents a
separate loading, unavailable, active-assignment, or standby state; a failed
read is never presented as an empty roster.

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