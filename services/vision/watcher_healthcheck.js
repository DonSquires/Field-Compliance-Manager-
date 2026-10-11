const fs = require('node:fs');

const healthPath = process.env.VISION_WATCHER_HEALTH_PATH || '/tmp/fcm-vision-watcher-health';
const maxAgeMs = Math.max(30_000, Number(process.env.VISION_WATCHER_HEALTH_MAX_AGE_MS || 90_000));

function stopStaleWatcher() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1 || pid === process.pid) continue;
    try {
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (command.includes('vision_job_watcher.js')) process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
}

try {
  const ageMs = Date.now() - fs.statSync(healthPath).mtimeMs;
  if (ageMs <= maxAgeMs) process.exit(0);
  stopStaleWatcher();
  console.error(`Vision watcher heartbeat is stale by ${Math.round(ageMs / 1000)} seconds`);
  process.exit(1);
} catch (error) {
  stopStaleWatcher();
  console.error(`Vision watcher heartbeat check failed: ${error.message}`);
  process.exit(1);
}
