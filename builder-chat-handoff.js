'use strict';

const HANDOFF_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'propose_builder_investigation',
    description: 'Prepare a real Bob Builder investigation handoff card when the owner requests builder work on a reported issue. It is NOT a source-verified repair plan. The owner must confirm Create job in the UI before any job exists. Builder must inspect source, schema, Atlas and existing jobs, establish cause and pass normal specification/review/release gates before implementing a fix. Do not use for ordinary questions or requests not to create/propose work. Vibe dispatch is not available from this tool; do not pretend it is.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['title', 'report_quote', 'assessment', 'investigation_steps', 'acceptance_checks', 'unknowns', 'frontend_required', 'backend_required'],
      properties: {
        title: { type: 'string', minLength: 4, maxLength: 140 },
        report_quote: { type: 'string', minLength: 1, maxLength: 1500 },
        assessment: { type: 'string', minLength: 40, maxLength: 1800 },
        investigation_steps: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 15, maxLength: 500 } },
        acceptance_checks: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 15, maxLength: 500 } },
        unknowns: { type: 'string', minLength: 10, maxLength: 800 },
        frontend_required: { type: 'boolean' },
        backend_required: { type: 'boolean' },
      },
    },
  },
});

function investigationProposal(args, message, sources = []) {
  const fields = HANDOFF_TOOL.function.parameters.properties;
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !Object.hasOwn(fields, key))) throw new Error('Invalid Builder investigation arguments');
  for (const [name, spec] of Object.entries(fields)) {
    const value = args[name];
    if (spec.type === 'string' && (typeof value !== 'string' || value.trim().length < spec.minLength || value.length > spec.maxLength)
        || spec.type === 'boolean' && typeof value !== 'boolean'
        || spec.type === 'array' && (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems
          || value.some(item => typeof item !== 'string' || item.trim().length < spec.items.minLength || item.length > spec.items.maxLength))) {
      throw new Error(`Invalid Builder investigation ${name}`);
    }
  }
  if (!args.frontend_required && !args.backend_required) throw new Error('Builder investigation requires at least one scope');
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const reports = [
    { source_id: 'current-question', content: message.content },
    { source_id: 'reviewed-summary', content: message.payload?.evidence_summary },
    ...sources.filter(source => source.transfer === 'locally_extracted_text' && source.attachment_id)
      .map(source => ({ source_id: source.id, attachment_id: source.attachment_id, sha256: source.sha256, content: source.content })),
  ].filter(source => typeof source.content === 'string');
  const quote = normalize(args.report_quote);
  const report = reports.find(source => quote.length < 15
    ? normalize(source.content) === quote : normalize(source.content).includes(quote));
  if (!report) {
    throw new Error('Builder investigation report quote must match the approved current packet');
  }
  const task = [
    'INVESTIGATION HANDOFF - not a source-verified repair plan.',
    `Originating PM message: ${message.id}`,
    `Report provenance: ${JSON.stringify({ source_id: report.source_id, ...(report.attachment_id ? { attachment_id: report.attachment_id, sha256: report.sha256 } : {}) })}`,
    `User-reported observation (not independently verified):\n"${args.report_quote}"`,
    `PM assessment (hypothesis, not established cause):\n${args.assessment}`,
    `Unknowns:\n${args.unknowns}`,
    `Investigation:\n${args.investigation_steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    `Acceptance checks:\n${args.acceptance_checks.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    'Before implementation: check the existing job ledger for duplicate work; use Atlas only as a map; inspect owning source, schema, callers and writers. Establish expected versus present behavior before/during/after. Establish cause, author the repair plan, and satisfy normal specification and approval gates. If evidence does not support a fix, report the blocker rather than inventing one.',
    'Preserve access, privacy, idempotency, audit and release controls. Use synthetic tests. A job, commit, PR or merge is not proof of a production repair; verify the deployed user outcome before claiming completion.',
  ].join('\n\n');
  if (task.length > 8000) throw new Error('Builder investigation handoff exceeds 8000 characters');
  return {
    title: `Investigate: ${args.title.trim()}`, task_description: task,
    frontend_required: args.frontend_required, backend_required: args.backend_required,
    rationale: 'Bob Builder handles the durable investigation and any evidence-supported fix through existing gates. Owner confirmation creates the job; no job has started yet.',
    handoff_kind: 'investigation', source_message_id: message.id,
  };
}

module.exports = { HANDOFF_TOOL, investigationProposal };
