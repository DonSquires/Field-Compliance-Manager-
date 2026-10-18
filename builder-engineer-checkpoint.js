'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

function checkpointDirectory(workspaceRoot, job) {
  return path.join(path.resolve(workspaceRoot), '.engineer-checkpoints', digest([job.organization_id, job.id]));
}

function engineerCheckpoint({ workspaceRoot, job, step, lane, inputKey }) {
  const identity = { organization_id: job.organization_id, job_id: job.id, step_id: step.id, lane, target_sha: job.target_sha };
  if (Object.values(identity).some(value => typeof value !== 'string' || !value)) throw new Error('Checkpoint identity is incomplete');
  const directory = checkpointDirectory(workspaceRoot, job);
  const file = path.join(directory, `${digest([step.id, lane])}.json`);
  return {
    load() {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error('Engineer checkpoint exceeds size limit');
      const envelope = JSON.parse(text);
      if (envelope.version !== 1 || envelope.checksum !== digest(envelope.state)) throw new Error('Engineer checkpoint checksum is invalid');
      if (digest(envelope.state.identity) !== digest(identity)) throw new Error('Engineer checkpoint identity or commit does not match');
      if (envelope.state.inputKey !== inputKey) return null;
      return envelope.state;
    },
    save(state) {
      const payload = { ...state, identity, inputKey, saved_at: new Date().toISOString() };
      const text = JSON.stringify({ version: 1, checksum: digest(payload), state: payload });
      if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error('Engineer checkpoint exceeds size limit');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'w', 0o600);
        fs.writeFileSync(descriptor, text);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, file);
        const parent = fs.openSync(directory, 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
      }
      return payload;
    },
  };
}

function retireEngineerCheckpoints(workspaceRoot, job) {
  const directory = checkpointDirectory(workspaceRoot, job);
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Engineer checkpoint directory is a symlink');
  fs.rmSync(directory, { recursive: true });
}

function hasEngineerCheckpoints(workspaceRoot, job) {
  return fs.existsSync(checkpointDirectory(workspaceRoot, job));
}

module.exports = { engineerCheckpoint, hasEngineerCheckpoints, retireEngineerCheckpoints };
