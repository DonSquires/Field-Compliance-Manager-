'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const intake = require('../builder-change-request-intake');
const { proposeIntent } = require('../builder-chat-session');

const PROJECT = { id: 'project-1', organization_id: 'org-1' };
const HEAD = 'b'.repeat(40);

function packet(overrides = {}) {
  return {
    id: '0c7efc66-97e1-4129-a6e2-12de6c6ebe4b',
    disposition: 'open',
    repair_risk: 'significant',
    automation_status: 'awaiting_grandmaster',
    stop_line_hit: null,
    builder_job_id: null,
    envelope: {
      before: { page: '/admin/timesheets', view_title: 'Timesheets', view_headings: ['Timesheets', 'Approvals'] },
      during: {
        user_report: {
          kind: 'change_request',
          current_behavior: 'There is no approve button. Call me on 021 555 1234 or jo.bloggs@example.co.nz.',
          desired_behavior: 'Add approve, cancel and edit buttons to every timesheet row.',
          business_reason: 'Payroll run 12345678 is late every week.',
        },
      },
    },
    ...overrides,
  };
}

function fakeSupabase({ rows = [], rpc = {} } = {}) {
  const calls = [];
  const updates = [];
  const client = {
    calls,
    updates,
    from(table) {
      const query = { table, filters: [] };
      const builder = {
        select() { return builder; },
        not(...args) { query.filters.push(['not', ...args]); return builder; },
        eq(...args) { query.filters.push(['eq', ...args]); return builder; },
        is(...args) { query.filters.push(['is', ...args]); return builder; },
        neq(...args) { query.filters.push(['neq', ...args]); return builder; },
        order() { return builder; },
        update(patch) { query.patch = patch; updates.push(query); return builder; },
        limit: async () => ({ data: rows, error: null }),
        then(resolve) { resolve({ data: null, error: null }); },
      };
      calls.push(['from', table, query]);
      return builder;
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      const handler = rpc[name];
      if (!handler) return { data: null, error: null };
      return handler(args);
    },
  };
  return client;
}

test('redaction masks emails, phone numbers and long digit runs in change-request text', () => {
  const text = intake.redactChangeRequestText('Ring 021 555 1234 or +64 9 123 4567, email jo.bloggs@example.co.nz, ref 12345678, room 12.');
  assert.doesNotMatch(text, /jo\.bloggs|example\.co\.nz/);
  assert.doesNotMatch(text, /555 1234|123 4567|12345678/);
  assert.match(text, /\[email\]/);
  assert.match(text, /\[phone\]/);
  assert.match(text, /\[number\]/);
  assert.match(text, /room 12\./);
});

test('the change-request brief is redacted, framed as untrusted feedback, and asks Bob to propose a job', () => {
  const brief = intake.changeRequestBrief(packet());
  assert.match(brief, /untrusted user feedback/i);
  assert.match(brief, /0c7efc66-97e1-4129-a6e2-12de6c6ebe4b/);
  assert.match(brief, /\/admin\/timesheets/);
  assert.match(brief, /approve, cancel and edit buttons/);
  assert.doesNotMatch(brief, /jo\.bloggs|555 1234|12345678/);
  assert.equal(proposeIntent(brief), true);
});

test('only open, unprotected, un-stopped change requests without a job are eligible', () => {
  assert.equal(intake.changeRequestEligible(packet()), true);
  assert.equal(intake.changeRequestEligible(packet({ repair_risk: 'protected' })), false);
  assert.equal(intake.changeRequestEligible(packet({ stop_line_hit: 'payroll' })), false);
  assert.equal(intake.changeRequestEligible(packet({ disposition: 'reviewing' })), false);
  assert.equal(intake.changeRequestEligible(packet({ builder_job_id: 'job-1' })), false);
  assert.equal(intake.changeRequestEligible(packet({ automation_status: 'failed' })), false);
  assert.equal(intake.changeRequestEligible(packet({ envelope: { before: {}, during: {} } })), false);
});

test('routing enqueues each eligible request into Builder chat with redacted content', async () => {
  const supabase = fakeSupabase({
    rows: [packet(), packet({ id: 'protected-1', repair_risk: 'protected' })],
    rpc: { builder_change_request_enqueue: async () => ({ data: 'message-1', error: null }) },
  });
  const outcomes = await intake.routeChangeRequests({ supabase, project: PROJECT });
  const enqueued = supabase.calls.filter(([kind, name]) => kind === 'rpc' && name === 'builder_change_request_enqueue');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0][2]._packet_id, packet().id);
  assert.equal(enqueued[0][2]._project_id, PROJECT.id);
  assert.doesNotMatch(enqueued[0][2]._content, /jo\.bloggs|555 1234/);
  assert.deepEqual(outcomes, [{ packet: packet().id, outcome: 'routed', message: 'message-1' }]);
});

test('routing first parks requests whose Builder chat turn never settled', async () => {
  const records = [];
  const supabase = fakeSupabase({ rpc: { builder_change_request_park_stale: async () => ({ data: 2, error: null }) } });
  await intake.routeChangeRequests({ supabase, project: PROJECT, record: (...args) => records.push(args) });
  const sweep = supabase.calls.find(([kind, name]) => kind === 'rpc' && name === 'builder_change_request_park_stale');
  assert.deepEqual(sweep[2], { _older_than_minutes: 180 });
  assert.equal(supabase.calls.indexOf(sweep), 0, 'the sweep runs before new requests are read');
  assert.deepEqual(records[0], ['builder.change_request.stale_parked', null, { count: 2 }]);
});

test('a routing failure for one request is reported without stopping the next', async () => {
  let first = true;
  const supabase = fakeSupabase({
    rows: [packet({ id: 'a' }), packet({ id: 'b' })],
    rpc: {
      builder_change_request_enqueue: async () => {
        if (first) { first = false; return { data: null, error: { message: 'Change request is no longer eligible' } }; }
        return { data: 'message-b', error: null };
      },
    },
  });
  const outcomes = await intake.routeChangeRequests({ supabase, project: PROJECT });
  assert.equal(outcomes[0].outcome, 'failed');
  assert.match(outcomes[0].error, /no longer eligible/);
  assert.deepEqual(outcomes[1], { packet: 'b', outcome: 'routed', message: 'message-b' });
});

const PROPOSAL = {
  title: 'Timesheets: add approve, cancel and edit actions',
  task_description: 'Add approve, cancel and edit row actions to the admin timesheets table using the existing timesheet RPCs.',
  frontend_required: true,
  backend_required: false,
};

const chatMessage = { id: 'message-1', thread_id: 'thread-1', payload: { change_request: { packet_id: packet().id, auto_implement: true } } };

test('a proposal from a routed change request creates and binds a Builder job on the current head', async () => {
  const supabase = fakeSupabase({
    rpc: {
      builder_create_job_v2: async () => ({ data: { id: 'job-1' }, error: null }),
      builder_change_request_bind_job: async () => ({ data: { id: 'job-1' }, error: null }),
    },
  });
  const result = await intake.implementChangeRequest({ supabase, project: PROJECT, message: chatMessage, proposal: PROPOSAL, head: HEAD });
  assert.deepEqual(result, { jobId: 'job-1' });
  const create = supabase.calls.find(([kind, name]) => kind === 'rpc' && name === 'builder_create_job_v2')[2];
  assert.equal(create._target_sha, HEAD);
  assert.equal(create._project_id, PROJECT.id);
  assert.equal(create._organization_id, PROJECT.organization_id);
  assert.equal(create._title, PROPOSAL.title);
  assert.equal(create._requested_action, 'prepare_change');
  assert.equal(create._target_environment, 'development');
  assert.equal(create._code_review_mode, 'independent_ai');
  assert.equal(create._frontend_required, true);
  assert.equal(create._backend_required, false);
  assert.match(create._task_description, new RegExp(packet().id));
  const bind = supabase.calls.find(([kind, name]) => kind === 'rpc' && name === 'builder_change_request_bind_job')[2];
  assert.deepEqual(bind, { _job_id: 'job-1', _packet_id: packet().id, _message_id: 'message-1' });
});

test('a job that cannot be bound is cancelled and the request is parked for the owner', async () => {
  const supabase = fakeSupabase({
    rpc: {
      builder_create_job_v2: async () => ({ data: { id: 'job-1' }, error: null }),
      builder_change_request_bind_job: async () => ({ data: null, error: { message: 'Change request is not claimed' } }),
    },
  });
  await assert.rejects(
    intake.implementChangeRequest({ supabase, project: PROJECT, message: chatMessage, proposal: PROPOSAL, head: HEAD }),
    /not claimed/,
  );
  const cancel = supabase.updates.find(query => query.table === 'builder_jobs');
  assert.equal(cancel.patch.status, 'cancelled');
  assert.deepEqual(cancel.filters.find(filter => filter[1] === 'id'), ['eq', 'id', 'job-1']);
  const park = supabase.calls.find(([kind, name]) => kind === 'rpc' && name === 'builder_change_request_park');
  assert.equal(park[2]._packet_id, packet().id);
  assert.match(park[2]._reason, /not claimed/);
});

test('a job is never created without a current main head', async () => {
  const supabase = fakeSupabase();
  await assert.rejects(intake.implementChangeRequest({ supabase, project: PROJECT, message: chatMessage, proposal: PROPOSAL, head: null }), /main head/);
  assert.equal(supabase.calls.some(([kind, name]) => kind === 'rpc' && name === 'builder_create_job_v2'), false);
});

test('parking records a redacted single-line reason', async () => {
  const supabase = fakeSupabase();
  await intake.parkChangeRequest({ supabase, packetId: 'p-1', reason: 'No proposal.\nContact jo@example.com' });
  const park = supabase.calls.find(([kind, name]) => kind === 'rpc' && name === 'builder_change_request_park')[2];
  assert.equal(park._packet_id, 'p-1');
  assert.doesNotMatch(park._reason, /\n|jo@example\.com/);
});

test('the control plane routes change requests each tick and settles them through the chat worker', () => {
  const server = fs.readFileSync(path.join(__dirname, '../bob-control-plane-server.js'), 'utf8');
  assert.match(server, /require\('\.\/builder-change-request-intake'\)/);
  assert.match(server, /process\.env\.BOB_CHANGE_REQUEST_AUTOBUILD !== 'false'/);
  assert.match(server, /await startRoutineRepairs\(\);\n\s+await startChangeRequestIntake\(\);/);
  assert.match(server, /routeChangeRequests\(\{ supabase: builderSupabase, project: await routineBuilderProject\(\)/);
  assert.match(server, /changeRequests: \{\n\s+implement: async \(\{ message, proposal, head \}\) => implementChangeRequest\(/);
  assert.match(server, /park: \(\{ packetId, reason \}\) => parkChangeRequest\(/);
  // Packet status follows the job for change requests as well as routine repairs.
  assert.match(server, /routineJob\?\.autopilot_source === 'routine_monitor' \|\| routineJob\?\.autopilot_source == null/);
});
