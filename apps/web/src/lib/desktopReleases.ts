/** Where the FCM desktop installers live. One source for the shell's download prompt and any page that points at them. */
export const DESKTOP_V1_DOWNLOAD_URL = 'https://github.com/DonSquires/Field-Compliance-Manager-/releases/download/sd-card-bridge-v0.1.53/FCM-SD-Card-Bridge-Setup.exe';
export const DESKTOP_V2_VERSION = '0.4.5';
export const DESKTOP_V2_FILENAME = `FCM-Desktop-V2-v${DESKTOP_V2_VERSION}-Setup.exe`;
export const DESKTOP_V2_RELEASE_BASE = `https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/desktop-releases/v2/${DESKTOP_V2_VERSION}`;
export const DESKTOP_V2_DOWNLOAD_URL = `${DESKTOP_V2_RELEASE_BASE}/FCM-Desktop-V2-Setup.exe?download=${DESKTOP_V2_FILENAME}`;
export const DESKTOP_V2_MANIFEST_URL = `${DESKTOP_V2_RELEASE_BASE}/manifest.json`;
