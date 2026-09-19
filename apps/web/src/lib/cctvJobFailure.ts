/**
 * Turns a CCTV analysis job's raw failure text (ffmpeg/ffprobe/OpenCV/PostgREST output) into what a reviewer
 * needs: what went wrong in plain words, whether a retry is likely to help, and the concrete next step.
 * The classifier is deliberately conservative: anything it does not recognise is reported as unknown and
 * left retryable, with the raw text available for an engineer.
 */
export type JobFailureKind = 'unreadable_source' | 'corrupt_stream' | 'transient_infrastructure' | 'timeout' | 'lease_lost' | 'unsupported_media' | 'unknown';

export type JobFailure = {
  kind: JobFailureKind;
  /** One line for the queue row. */
  title: string;
  /** What actually happened, for the detail panel. */
  explanation: string;
  /** The reviewer's safe next move. */
  nextStep: string;
  /** Whether pressing Retry is expected to change the outcome without any other change. */
  retryLikelyHelps: boolean;
};

const RAW_CONTAINER_HINT = /\.(dhfs|dav|264|265|h264|h265|hevc)(\b|$)/i;

export function describeJobFailure(rawMessage: string | null | undefined, fileName?: string | null): JobFailure {
  const message = (rawMessage ?? '').trim();
  const lower = message.toLowerCase();
  const rawContainer = fileName ? RAW_CONTAINER_HINT.test(fileName) : false;

  if (/unable to read video headers|moov atom not found|invalid data found when processing input|could not find codec parameters|no such file or directory/.test(lower)) {
    return {
      kind: 'unreadable_source',
      title: rawContainer ? 'Raw camera fragment: no readable video header' : 'The file has no readable video header',
      explanation: rawContainer
        ? 'This is a raw fragment straight from the camera card (Dahua DHFS/DAV or a bare H.264/H.265 stream). The analysis worker needs a container it can index, and this file does not carry one.'
        : 'The decoder could not find a video header in this file. It may be an unused ring-slot, a partial copy, or a file that is not video at all.',
      nextStep: rawContainer
        ? 'Re-export this recording through the FCM Desktop reader (which wraps the raw frames in a playable file) and import that. Retrying this job as-is will fail the same way.'
        : 'Check the file opens in a media player. If it does not, it is not usable evidence; close this job. If it does, re-import the file.',
      retryLikelyHelps: false,
    };
  }

  if (/log2_max_poc_lsb|illegal poc type|missing picture in access unit|non-existing pps|decode_slice_header error|error while decoding|corrupt|truncat|invalid nal unit/.test(lower)) {
    return {
      kind: 'corrupt_stream',
      title: 'The video stream is damaged',
      explanation: 'The H.264/H.265 stream inside this file is corrupted — typically a recording cut mid-frame at a ring-slot boundary, or a card that was pulled while writing. The decoder gave up before any frames could be analysed.',
      nextStep: 'If a media player can play part of it, the recording still has evidential value: keep the original, lock it if needed, and review it manually in the console. Retrying will not repair the stream.',
      retryLikelyHelps: false,
    };
  }

  if (/lease was lost|lease token|claimed by another/.test(lower)) {
    return {
      kind: 'lease_lost',
      title: 'Another worker took over this job',
      explanation: 'Two analysis workers overlapped on the same job and this attempt yielded to the other one. No footage was lost.',
      nextStep: 'Retry. If it keeps happening, report it — it suggests the workers are overloaded or their clocks disagree.',
      retryLikelyHelps: true,
    };
  }

  if (/statement timeout|canceling statement|timed out|timeout/.test(lower)) {
    return {
      kind: 'timeout',
      title: 'The database was too slow to keep up',
      explanation: 'A write during analysis waited longer than the database allows and was cancelled. This happens under load or when a very large clip produces thousands of events at once.',
      nextStep: 'Retry — the work is checkpointed, so the second attempt resumes rather than starting over. If it fails again the same way, report it.',
      retryLikelyHelps: true,
    };
  }

  if (/fetch failed|econnreset|econnrefused|http 5\d\d|network|socket hang up|gateway|service unavailable/.test(lower)) {
    return {
      kind: 'transient_infrastructure',
      title: 'A service the worker depends on was unavailable',
      explanation: 'The analysis worker could not reach the inference service, the database or storage for a moment. The footage itself is fine.',
      nextStep: 'Retry. The checkpointed frames are kept, so only the missing steps run again.',
      retryLikelyHelps: true,
    };
  }

  if (/evidence item is not video|not a video|unsupported (media|codec|format)|unknown codec/.test(lower)) {
    return {
      kind: 'unsupported_media',
      title: 'This evidence is not a video the worker can analyse',
      explanation: 'The evidence item was registered with a type or codec the analysis worker does not handle.',
      nextStep: 'Close this job. If the file is genuinely CCTV footage, re-import it through the CCTV import page so it is registered correctly.',
      retryLikelyHelps: false,
    };
  }

  return {
    kind: 'unknown',
    title: message ? 'Analysis failed for a reason not yet recognised' : 'Analysis failed without a recorded reason',
    explanation: message ? 'The worker reported an error this page does not recognise. The raw message is kept for an engineer.' : 'The worker recorded no failure message. This usually means it stopped abruptly (out of memory or restarted mid-job).',
    nextStep: 'Retry once. If it fails again, close the job and report it with the raw message.',
    retryLikelyHelps: true,
  };
}

/** Summary line for a queue header: how many failures a retry can plausibly fix. */
export function summariseFailures(failures: JobFailure[]): { retryable: number; permanent: number } {
  return failures.reduce((acc, failure) => {
    if (failure.retryLikelyHelps) acc.retryable += 1; else acc.permanent += 1;
    return acc;
  }, { retryable: 0, permanent: 0 });
}
