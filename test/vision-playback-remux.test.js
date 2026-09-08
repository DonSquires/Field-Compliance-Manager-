const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { playbackStoragePath } = require('../services/vision/vision_job_watcher');

test('playbackStoragePath replaces the source extension with .playback.mp4', () => {
  assert.equal(
    playbackStoragePath('desktop/user-1/attachment-1-FCM-card-p0-d000072.h264'),
    'desktop/user-1/attachment-1-FCM-card-p0-d000072.playback.mp4'
  );
});

test('playbackStoragePath handles sources that already carry a playable container extension', () => {
  assert.equal(playbackStoragePath('desktop/user-1/export.mp4'), 'desktop/user-1/export.playback.mp4');
});

test('playbackStoragePath handles paths without an extension', () => {
  assert.equal(playbackStoragePath('desktop/user-1/attachment-1-clip'), 'desktop/user-1/attachment-1-clip.playback.mp4');
});
