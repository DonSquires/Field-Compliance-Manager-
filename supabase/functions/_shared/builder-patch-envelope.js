// The agentic engineer's model-run output is a JSON proposal envelope
// ({ summary, patch, changed_files, tests, ... }); the one-shot engineers emitted the
// raw unified diff. Downstream review workers need the diff, while provenance
// (reviewer != author, reviewed_artifact_ids) is anchored on the author's artifact id.
// This helper lets every consumer accept either shape without changing the anchor.
function unwrapPatchArtifact(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return { patch: text, envelope: null };
  try {
    const envelope = JSON.parse(trimmed);
    if (envelope && typeof envelope.patch === 'string' && envelope.patch.trim()) {
      return { patch: envelope.patch.endsWith('\n') ? envelope.patch : `${envelope.patch}\n`, envelope };
    }
  } catch { /* not an envelope */ }
  return { patch: text, envelope: null };
}

module.exports = { unwrapPatchArtifact };
