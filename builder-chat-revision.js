'use strict';

const REVISION_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'request_builder_spec_revision',
    description: 'Prepare owner-confirmed review feedback for an EXISTING Bob Builder job created in this chat thread and waiting for specification approval. Use when the owner asks to revise that job, never create a duplicate. Include the exact job UUID supplied in the approved packet and a bounded revision request. The server attaches the current user message verbatim as the human review report: no pasted specification or source inspection is required to deliver reported feedback. Does not approve, implement, merge or deploy. The UI confirmation records feedback, supersedes the pending specification and returns the same job to analysis.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['job_id', 'feedback'],
      properties: {
        job_id: { type: 'string', format: 'uuid' },
        feedback: { type: 'string', minLength: 40, maxLength: 4000 },
      },
    },
  },
});

const CODE_CHANGES_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'request_builder_code_changes',
    description: 'Prepare owner-confirmed implementation corrections for an EXISTING Bob Builder job from this thread waiting for HUMAN CODE REVIEW. Supply the exact job UUID from the approved current packet and bounded feedback. No private code is needed merely to deliver human review. Confirmation cancels the current review, retains its evidence, returns the SAME job to implementation, reruns verification/security, then requires fresh human review. Never create a duplicate or rewind the specification. Does not approve, merge or deploy.',
    parameters: REVISION_TOOL.function.parameters,
  },
});

async function prepareRevision(args, message, supabase, implementation) {
  const label = implementation ? 'Implementation correction' : 'Specification revision';
  if (!args || Object.keys(args).some(key => !['job_id', 'feedback'].includes(key))
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.job_id || '')
      || typeof args.feedback !== 'string' || args.feedback.trim().length < 40 || args.feedback.length > 4000) {
    throw new Error(`${label} requires a supplied job UUID and bounded feedback`);
  }
  const packet = [message.content, message.payload?.evidence_summary].filter(value => typeof value === 'string');
  if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 2000
      || !packet.some(text => text.includes(args.job_id))) {
    throw new Error(`${label} job must match the approved current packet`);
  }
  const { data: linked, error: linkError } = await supabase.from('builder_chat_messages').select('id')
    .eq('thread_id', message.thread_id).eq('kind', 'proposal').eq('payload->>job_id', args.job_id).limit(1);
  if (linkError) throw new Error(`Could not verify the existing handoff: ${linkError.message}`);
  if (!linked?.length) throw new Error('This job has no accepted handoff in the current chat thread');
  const { data: approvals, error } = await supabase.from('builder_approvals')
    .select('id,requested_target_sha').eq('job_id', args.job_id)
    .eq('approval_type', implementation ? 'implementation_review' : 'specification_review').eq('status', 'pending').limit(2);
  if (error) throw new Error(`Could not read the pending review gate: ${error.message}`);
  if (approvals?.length !== 1) throw new Error(`The existing job must have exactly one pending ${implementation ? 'human code' : 'specification'} review`);
  return {
    ...(implementation ? { kind: 'implementation' } : {}),
    job_id: args.job_id, approval_id: approvals[0].id, target_sha: approvals[0].requested_target_sha,
    source_message_id: message.id, review_quote: message.content.trim(), feedback: args.feedback.trim(),
  };
}

const prepareSpecRevision = (args, message, supabase) => prepareRevision(args, message, supabase, false);
const prepareCodeChanges = (args, message, supabase) => prepareRevision(args, message, supabase, true);

module.exports = { REVISION_TOOL, CODE_CHANGES_TOOL, prepareSpecRevision, prepareCodeChanges };
