// Builder job titles are read by the owner in the control room and by the Product Analyst as the job goal.
// Job #100 (2026-10-21) was titled with a raw chat message ("subagent has found a restriction that i
// think needs to be removed : The only verified single-file ..."), so derive a short outcome-style title.

const FILLER = /^(?:(?:ok(?:ay)?|hi|hey|right|so|now|also|and|then|bob|builder|please|pls|can you|could you|would you|i want you to|i need you to|i(?:'d| would) like you to|we need to|lets|let's)\b[\s,:-]*)+/i;

export const BUILDER_JOB_TITLE_MAX = 90;

export function builderJobTitle(text, fallback = 'Implement the requested FCM change') {
  const flat = String(text ?? '').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  let title = (flat.split(/(?<=[.!?])\s/)[0] || '').split(/\s[:;]\s|\s-\s/)[0].replace(FILLER, '').trim();
  title = title.replace(/[.!?,;:\s]+$/, '');
  if (!title) return fallback;
  if (title.length > BUILDER_JOB_TITLE_MAX) {
    const cut = title.slice(0, BUILDER_JOB_TITLE_MAX);
    title = `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : BUILDER_JOB_TITLE_MAX).replace(/[,;:\s]+$/, '')}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}
