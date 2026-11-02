const assert = require('node:assert/strict');
const test = require('node:test');
const { knownSignatureFor, normalizeFailureText, planRoutineIntake, routineRepairBrief, routineSignature } = require('../builder-routine-intake');

const packet = (id, page, message, failed) => ({
  id,
  envelope: {
    before: { page, module: 'admin' },
    during: { error: { kind: failed ? 'http_error' : 'exception', message }, ...(failed ? { failed_request: failed } : {}) },
    expected: {},
  },
  basis: {},
});

test('failure signatures ignore the page, deployment hashes, and asset names', () => {
  const hub = packet('p1', '/admin/hub', "Cannot read properties of undefined (reading '_leaflet_pos')");
  const subs = packet('p2', '/admin/module-subscriptions', "Cannot read properties of undefined (reading '_leaflet_pos')");
  assert.equal(routineSignature(hub), routineSignature(subs));
  assert.equal(routineSignature(hub), 'known:leaflet_after_unmount');

  const jsChunk = packet('p3', '/admin/users', 'Failed to fetch dynamically imported module: https://www.fcmanager.co.nz/assets/UserManagementPage-BXAa7IKO.js');
  const cssChunk = packet('p4', '/admin/hub', 'Unable to preload CSS for /assets/HubPage-Q1w2E3r4.css');
  assert.equal(routineSignature(jsChunk), 'known:stale_code_split_chunk');
  assert.equal(routineSignature(jsChunk), routineSignature(cssChunk));

  const failed = { fn: 'rest/access_presets', status: 500 };
  const platform = packet('p5', '/admin/platform', "Dr Bob's read-only production walk of 2aae6e175322 saw GET rest/access_presets return HTTP 500 on /admin/platform.", failed);
  const subscribers = packet('p6', '/admin/platform-subscribers', "Dr Bob's read-only production walk of 967bfa943f3f saw GET rest/access_presets return HTTP 500 on /admin/platform-subscribers.", failed);
  const workshop = packet('p7', '/admin/workshop', "Dr Bob's read-only production walk of 967bfa943f3f saw GET rest/workshop_work_order_summary return HTTP 500 on /admin/workshop.", { fn: 'rest/workshop_work_order_summary', status: 500 });
  assert.equal(routineSignature(platform), routineSignature(subscribers));
  assert.notEqual(routineSignature(platform), routineSignature(workshop), 'different relations are different defects');
  assert.equal(knownSignatureFor(platform).id, 'postgrest_server_error');

  assert.equal(normalizeFailureText('Job 3f2a9c1d-1111-4222-8333-444455556666 failed at /admin/x after 12345 ms'), 'job <uuid> failed at <path> after <n> ms');
  assert.notEqual(routineSignature(packet('a', '/x', 'TypeError: a is undefined')), routineSignature(packet('b', '/x', 'TypeError: b is undefined')));

  // PR #326 review: Dr Bob's message keeps navigation parameters in the page route; the page (with its
  // query) is not the defect, but the failing endpoint is.
  const presets = { fn: 'rest/access_presets', status: 500 };
  const tabOne = packet('p8', '/admin/manage?tab=one', 'GET rest/access_presets returned HTTP 500 on /admin/manage?tab=one&area=north.', presets);
  const tabTwo = packet('p9', '/admin/manage?tab=two', 'GET rest/access_presets returned HTTP 500 on /admin/manage?tab=two.', presets);
  assert.equal(routineSignature(tabOne), routineSignature(tabTwo));
  const routeA = packet('pa', '/admin/a', 'Request failed (HTTP 500)', { route: 'https://x.supabase.co/rest/v1/access_presets?select=*&id=eq.3f2a9c1d-1111-4222-8333-444455556666', status: 500 });
  const routeB = packet('pb', '/admin/b?tab=x', 'Request failed (HTTP 500)', { route: '/rest/v1/access_presets?select=id', status: 500 });
  const routeC = packet('pc', '/admin/a', 'Request failed (HTTP 500)', { route: '/rest/v1/workshop_work_order_summary?select=*', status: 500 });
  assert.equal(routineSignature(routeA), routineSignature(routeB), 'origin and query do not split one endpoint');
  assert.notEqual(routineSignature(routeA), routineSignature(routeC), 'a different endpoint is a different defect');
});

test('one repair is opened per signature and open repairs cover new packets', () => {
  const leafletHub = packet('p1', '/admin/hub', "reading '_leaflet_pos'");
  const leafletSubs = packet('p2', '/admin/module-subscriptions', "reading '_leaflet_pos'");
  const chunk = packet('p3', '/admin/users', 'Failed to fetch dynamically imported module: https://x/assets/A-12345678.js');
  const other = packet('p4', '/admin/staff', 'TypeError: staff.map is not a function');
  const { repairs, covered } = planRoutineIntake([leafletHub, chunk, leafletSubs, other], [{ jobId: 'job-chunk', signature: 'known:stale_code_split_chunk' }]);
  assert.deepEqual(repairs.map((repair) => [repair.packet.id, repair.followers.map((follower) => follower.id)]), [['p1', ['p2']], ['p4', []]]);
  assert.deepEqual(covered.map((entry) => [entry.packet.id, entry.jobId]), [['p3', 'job-chunk']]);
  assert.deepEqual(planRoutineIntake([], []), { repairs: [], covered: [] });
});

// PR #326 review: a parked job must not absorb new packets, and a covered packet starts where its owner is.
test('only repairs the autopilot still drives cover new packets, at the owning packet status', () => {
  const { routineRepairStillDriven } = require('../builder-routine-intake');
  for (const state of ['driving', 'awaiting_human', 'published']) assert.equal(routineRepairStillDriven({ autopilot_state: state }), true, state);
  assert.equal(routineRepairStillDriven({ autopilot_state: 'blocked', autopilot_report: { reason: 'acceptance_incomplete' } }), false, 'a parked acceptance_incomplete job never updates followers');
  assert.equal(routineRepairStillDriven({ autopilot_state: 'blocked', autopilot_report: { repair_job_id: 'r1' } }), true, 'waiting on a repair of main is still driven');
  assert.equal(routineRepairStillDriven({ autopilot_state: 'blocked', autopilot_report: { repair_job_id: 'r1', repair_outcome: 'failed' } }), false);
  assert.equal(routineRepairStillDriven({ autopilot_state: 'done' }), false);
  assert.equal(routineRepairStillDriven({ autopilot_state: null }), false);

  const leaflet = packet('p1', '/admin/hub', "reading '_leaflet_pos'");
  const chunk = packet('p2', '/admin/users', 'Failed to fetch dynamically imported module: https://x/assets/A-12345678.js');
  const { covered } = planRoutineIntake([leaflet, chunk], [
    { jobId: 'job-map', signature: 'known:leaflet_after_unmount', automationStatus: 'awaiting_grandmaster' },
    { jobId: 'job-chunk', signature: 'known:stale_code_split_chunk', automationStatus: 'failed' },
  ]);
  assert.deepEqual(covered.map((entry) => [entry.jobId, entry.automationStatus]), [['job-map', 'awaiting_grandmaster'], ['job-chunk', 'builder_started']]);

  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'bob-control-plane-server.js'), 'utf8');
  assert.match(server, /select\('id,source_friction_packet_id,autopilot_state,autopilot_report'\)[^]*?\.filter\(routineRepairStillDriven\)/);
  assert.match(server, /automationStatus: source\.automation_status \?\? null/);
  assert.match(server, /await coverRoutinePacket\(packet, jobId, signature, automationStatus\)/);
  assert.match(server, /automation_status: automationStatus,\n    covered_by_job_id: jobId/);
});

test('the routine brief points at the shared root cause and every affected page', () => {
  const hub = packet('p1', '/admin/hub', "Cannot read properties of undefined (reading '_leaflet_pos')");
  const subs = packet('p2', '/admin/module-subscriptions', "Cannot read properties of undefined (reading '_leaflet_pos')");
  const brief = routineRepairBrief(hub, { alsoReported: [subs, hub] });
  assert.match(brief, /^Goal: repair the routine monitored defect recorded in friction packet p1\./);
  assert.match(brief, /^Also reported on: \/admin\/module-subscriptions with the same failure signature/m);
  assert.match(brief, /^Known signature: a Leaflet map is still animating/m);
  assert.match(brief, /Likely shared files: apps\/web\/src\/components\/LocationHouseMap\.tsx/);
  assert.match(brief, /record a scope_amendment with the reason/);
  assert.match(brief, /^Routine boundary: .*Do not redesign, add a feature\/module\/workflow/m);
  assert.doesNotMatch(routineRepairBrief(packet('p9', '/admin/x', 'TypeError: q is undefined')), /Known signature|Also reported on/);

  const database = routineRepairBrief(packet('p5', '/admin/platform', 'GET rest/access_presets return HTTP 500', { fn: 'rest/access_presets', status: 500 }));
  assert.match(database, /; request rest\/access_presets returned 500\./);
  assert.match(database, /one new additive migration in supabase\/migrations\//);
  assert.match(database, /Never weaken a policy/);
});
