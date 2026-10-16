const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const chat = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const start = chat.indexOf('    const builderBriefGrounding = ');
assert.ok(start >= 0);
const source = chat.slice(start, chat.indexOf('    const builderCancellationDecision = ', start))
  .replace('(userTexts: string | string[], brief: string)', '(userTexts, brief)')
  .replace(/\(text: string\)/g, '(text)')
  .replace(/\[\] as string\[\]/g, '[]');
const builderBriefGrounding = vm.runInNewContext(`(() => { ${source} return builderBriefGrounding; })()`);
const builderIntentStart = chat.indexOf('    const explicitBuilderCreationRequest = ');
assert.ok(builderIntentStart >= 0);
const builderIntentSource = chat.slice(builderIntentStart, chat.indexOf('    const builderJobArgsFromEvidence = ', builderIntentStart))
  .replace(/\(text: string\)/g, '(text)')
  .replace('(text: string, fallbackFrontend = false, fallbackBackend = true)', '(text, fallbackFrontend = false, fallbackBackend = true)');
const explicitBuilderCreationRequest = vm.runInNewContext(`(() => { ${builderIntentSource} return explicitBuilderCreationRequest; })()`);
const builderLanesForOwnerRequest = vm.runInNewContext(`(() => { ${builderIntentSource} return builderLanesForOwnerRequest; })()`);
const continuesBuilderRequest = vm.runInNewContext(`(() => { ${builderIntentSource} return continuesBuilderRequest; })()`);
const builderProposalDecision = vm.runInNewContext(`(() => { ${builderIntentSource} return builderProposalDecision; })()`);

const request = "In Bob's chat, whenever Bob asks me a question or proposes something that needs my confirmation — a Builder job proposal, a laptop command, a cancellation — show tappable choice buttons under his message, for example 'Yes, run it' / 'Change it' / 'No'. Server side, in supabase/functions/onspace-ai-chat/index.ts, include meta.options on every proposed outcome; client side, in apps/web/src/components/BobPanel.tsx, render metadata.options as accessible buttons. Add component tests.";

test('Builder proposal confirmation rejects negative and ambiguous answers', () => {
  assert.equal(builderProposalDecision('No, cancel'), 'decline');
  assert.equal(builderProposalDecision('cancel'), 'decline');
  assert.equal(builderProposalDecision('change the brief'), null);
  assert.equal(builderProposalDecision('yes, open the Builder job'), 'confirm');
});

test('a brief copied from the planner prompt example is not grounded in the request (job b2ce9660)', () => {
  const fabricated = "Fix Freedom Camping Zone Classification. The council has requested a review of the classification for Zone 123 at Client XYZ. The current classification is 'prohibited', but the council wants to change it to 'restricted'. The zone requires an SCV certificate for entry.";
  const verdict = builderBriefGrounding(request, fabricated);
  assert.equal(verdict.grounded, false);
  assert.ok(verdict.overlap < 0.25, `overlap ${verdict.overlap}`);
  assert.deepEqual(JSON.parse(JSON.stringify(verdict.missing_paths)), ['supabase/functions/onspace-ai-chat/index.ts', 'apps/web/src/components/BobPanel.tsx']);
});

test('a restructured brief that keeps the request\'s substance and paths is grounded', () => {
  const brief = "Goal: tappable choice buttons under Bob's messages whenever Bob proposes or asks for confirmation (Builder job proposal, laptop command, cancellation). Server: supabase/functions/onspace-ai-chat/index.ts adds meta.options to proposed outcomes. Client: apps/web/src/components/BobPanel.tsx renders metadata.options as accessible buttons. Acceptance: component tests cover rendering and sending; typed replies still work.";
  const verdict = builderBriefGrounding(request, brief);
  assert.equal(verdict.grounded, true, JSON.stringify(verdict));
  assert.ok(verdict.overlap >= 0.25);
});

test('a brief that drops a path the person named is not grounded even when the words overlap', () => {
  const brief = "Add tappable choice buttons under Bob's messages for Builder job proposals, laptop commands and cancellations; server side add meta.options to every proposed outcome in supabase/functions/onspace-ai-chat/index.ts; client side render metadata.options as accessible buttons; add component tests.";
  const verdict = builderBriefGrounding(request, brief);
  assert.equal(verdict.grounded, false);
  assert.deepEqual(JSON.parse(JSON.stringify(verdict.missing_paths)), ['apps/web/src/components/BobPanel.tsx']);
});

test('short requests cannot be judged and pass', () => {
  assert.equal(builderBriefGrounding('fix the login bug', 'Anything at all').grounded, true);
});

test('judged against recent messages: a nudge is not the brief, and the replacement is the real request (jobs 2fba8ca0, 02378cc2)', () => {
  const nudge = 'Do not investigate in chat. Compose the Builder job now from my brief exactly as written; the job does the reading and the changes.';
  const fabricated = 'Fix Freedom Camping Zone Classification. The council has requested a review of Zone 123 at Client XYZ.';
  const verdict = builderBriefGrounding([nudge, request], fabricated);
  assert.equal(verdict.grounded, false);
  assert.equal(verdict.source, request, 'the replacement brief is the real request, not the nudge');
  // A draft that matches only the nudge is not grounded either: the reference is the substantial request.
  const nudgeLike = 'A brief for the Builder: investigate the chat and compose written changes; reading the job.';
  const nudged = builderBriefGrounding([nudge, request], nudgeLike);
  assert.equal(nudged.grounded, false);
  assert.equal(nudged.source, request);
  // A grounded brief is accepted when it matches any recent request.
  const good = "Tappable choice buttons under Bob's messages for proposals and confirmations: supabase/functions/onspace-ai-chat/index.ts adds meta.options; apps/web/src/components/BobPanel.tsx renders metadata.options as accessible buttons; a Builder job proposal, laptop command or cancellation shows them; component tests added.";
  assert.equal(builderBriefGrounding([nudge, request], good).grounded, true);
});

test('the create_builder_job proposal replaces an ungrounded draft with the owner\'s own words and says so', () => {
  const branch = chat.slice(chat.indexOf("case 'create_builder_job':"), chat.indexOf("case 'cancel_builder_job':"));
  assert.match(branch, /const bjGrounding = storedJob \? \{ grounded: true[^}]*\} : builderBriefGrounding\(bjRecentRequests, `\$\{bjTitle\} \$\{bjDescription\}`\)/);
  assert.match(branch, /const bjRecentRequests = \[String\(message \?\? ''\), \.\.\.history\.filter\(\(h\) => h\.role === 'user'\)/);
  assert.match(branch, /if \(!bjGrounding\.grounded\) \{/);
  assert.match(branch, /bjDescription = `\$\{ownWords\.slice\(0, 11000\)\}/);
  assert.match(branch, /so I have used your own words as the brief/);
  assert.match(branch, /grounding: \{ grounded: bjGrounding\.grounded, overlap: Number\(bjGrounding\.overlap\.toFixed\(2\)\), replaced_with_owner_words: !bjGrounding\.grounded \}/);
});

test('an explicit owner build request cannot stop at a prose plan after evidence gathering', () => {
  const loop = chat.slice(chat.indexOf('const nextPlan = await callPlan('), chat.indexOf('// ASK halts the loop'));
  assert.match(loop, /explicitBuilderCreationRequest\(message\)/);
  assert.match(loop, /tool: 'create_builder_job'/);
  assert.match(loop, /builderJobArgsFromEvidence\(message, loopSteps\)/);
});

test('an explicit owner build enters the durable Builder before chat evidence loops can exhaust the turn', () => {
  assert.match(chat, /const recentBuilderRequest = \[/);
  assert.match(chat, /history\.filter\(\(entry\) => entry\.role === 'user'\)/);
  assert.match(chat, /const continuesBuilderRequest =/);
  assert.match(chat, /const builderArgs = builderJobArgsFromEvidence\(recentBuilderRequest, \[\]\)/);
  assert.match(chat, /admit it to the durable Builder runtime instead of spending the chat-turn budget/);
  const admission = chat.slice(chat.indexOf('const recentBuilderRequest = '), chat.indexOf('// PILLAR H: plan_received'));
  assert.match(admission, /const currentIsBuilderRequest = explicitBuilderCreationRequest\(message\)/);
  assert.match(admission, /currentIsBuilderRequest \|\| \(continuesBuilderRequest\(message\)/);
  assert.match(admission, /continuesBuilderRequest\(message\)[\s\S]*!explicitHumanTestRequest[\s\S]*!explicitAtlasRequest[\s\S]*!explicitSchemaRequest/);
});

test('natural Builder proposal approvals resume the substantial request', () => {
  assert.equal(continuesBuilderRequest('yes'), true);
  assert.equal(continuesBuilderRequest('Yes, open the Builder job and proceed autonomously.'), true);
  assert.equal(continuesBuilderRequest('Go ahead and start this Builder job now.'), true);
  assert.equal(continuesBuilderRequest('Yes, but do not open it.'), false);
  assert.equal(continuesBuilderRequest('Can you explain the proposal first?'), false);
});

test('Codespaces-like Builder and vibe-coding workspace requests are software-build intent', () => {
  assert.equal(explicitBuilderCreationRequest('Redesign Bob Builder as a fully functioning Codespaces-like coding workspace.'), true);
  assert.equal(explicitBuilderCreationRequest('Design the Bob Builder vibe coding agent from scratch.'), true);
  assert.equal(explicitBuilderCreationRequest('Explain how a generic system works.'), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(builderLanesForOwnerRequest('Design Bob Builder as a fully functioning Codespaces-like vibe coding system.'))),
    { frontend: true, backend: true },
  );
  assert.equal(
    explicitBuilderCreationRequest('Redesign and fix the Bob chat page and Builder Studio. Inspect Atlas and schema, then run Dr Bob human tests.'),
    true,
  );
});

test('explicit Atlas and schema audits cannot escape into web research or omit schema', () => {
  assert.match(chat, /if \(explicitAtlasRequest && \(normAction === 'answer' \|\| explicitReadOnlyAtlasRequest \|\| chosenTool === 'web_research'\) && chosenTool !== 'query_atlas'\)/);
  assert.match(chat, /if \(!explicitAtlasRequest && explicitSchemaRequest && chosenTool !== 'schema_inspect'\)/);
  assert.match(chat, /explicitAtlasRequest && explicitSchemaRequest && atlasCompleted && !schemaCompleted/);
  assert.match(chat, /'builder_jobs',[\s\S]*'builder_worker_runs'/);
  assert.match(chat, /args: explicitSchemaArgs/);
  assert.match(chat, /tool: 'schema_inspect'/);
});

test('a research-gated Builder attempt performs the missing research and retries without another proceed turn', () => {
  assert.match(chat, /chosenTool === 'create_builder_job'\s*&& result\.meta\.outcome === 'need_research'/);
  assert.match(chat, /history\.filter\(\(entry\) => entry\.role === 'user'\)/);
  assert.match(chat, /const firstResearch = await execWebResearch\(authHeader, researchRequest\)/);
  assert.match(chat, /if \(researchUrls\.length >= 4\)/);
  assert.match(chat, /Builder required governed public-source provenance/);
  assert.match(chat, /result = await dispatchTool\(chosenTool, args, decision\)/);
});

test('an explicit owner build request cannot fall through to synthesis at the evidence step cap', () => {
  const postLoop = chat.slice(chat.indexOf('// Step cap reached:'), chat.indexOf('// END REASONING LOOP'));
  assert.match(postLoop, /LOOP_CONTINUABLE_READ_TOOLS\.has\(chosenTool\).*explicitBuilderCreationRequest\(message\)/s);
  assert.match(postLoop, /chosenTool = 'create_builder_job'/);
  assert.match(postLoop, /result = await dispatchTool\(chosenTool, args, decision\)/);
  assert.match(chat, /Evidence gathered before proposal:/);
  assert.match(chat, /Required verification contract:/);
  assert.match(chat, /Keep flow_reach separate from fk_reach/);
  assert.match(chat, /refresh Atlas, and refresh\/check the live schema snapshot/);
});

test('an explicit self-heal request turns a confirmed friction route into a real Builder receipt', () => {
  const loop = chat.slice(chat.indexOf('const nextPlan = await callPlan('), chat.indexOf('// ASK halts the loop'));
  assert.match(loop, /result\.meta\.tool === 'triage_friction'/);
  assert.match(loop, /result\.meta\.repair_ready === true/);
  assert.match(loop, /owner_instruction_confirmed: true/);
  assert.match(loop, /source_friction_packet_id: result\.meta\.packet_id/);
  const builder = chat.slice(chat.indexOf("case 'create_builder_job':"), chat.indexOf("case 'cancel_builder_job':"));
  assert.match(builder, /const confirmedByTriage = toolArgs\.owner_instruction_confirmed === true/);
  assert.match(builder, /navigation_actions: \[\{ label: 'Open Builder control room'/);
  assert.match(builder, /label: 'Merge, deploy, and prove in the glass'/);
});

test('natural-language Builder jobs carry an explicit app, coding, or self-heal mode contract', () => {
  const argsStart = chat.indexOf('    const builderModeForRequest = ');
  const argsSource = chat.slice(argsStart, chat.indexOf('/** Dispatch a single tool', argsStart))
    .replace('(text: string, evidenceSteps: Array<{ tool: string; result_summary: string }>)', '(text, evidenceSteps)')
    .replace('(text: string, fallbackFrontend = false, fallbackBackend = true)', '(text, fallbackFrontend = false, fallbackBackend = true)')
    .replace(/\(text: string\)/g, '(text)');
  const builderJobArgsFromEvidence = vm.runInNewContext(`(() => { ${argsSource} return builderJobArgsFromEvidence; })()`);
  assert.match(builderJobArgsFromEvidence('Build me a patrol handover app', []).task_description, /Builder mode: no_code_app_generation/);
  assert.match(builderJobArgsFromEvidence('Add an API-backed handover page', []).task_description, /Builder mode: chat_to_code/);
  assert.match(builderJobArgsFromEvidence('Repair the failing Builder test', []).task_description, /Builder mode: autonomous_self_heal/);
  assert.equal(builderJobArgsFromEvidence('Build me a patrol handover app', []).owner_instruction_confirmed, true);
});

test('an explicit owner build instruction proposes before opening the autonomous job', () => {
  const builder = chat.slice(chat.indexOf("case 'create_builder_job':"), chat.indexOf("case 'cancel_builder_job':"));
  assert.match(builder, /const proposalDecision = storedJob \? builderProposalDecision\(message\) : null/);
  assert.match(builder, /\(!storedJob \|\| proposalDecision !== 'confirm'\) && !confirmedByTriage/);
  assert.match(builder, /outcome: 'proposed'/);
  assert.match(builder, /autopilot: true/);
});

test('the exact live owner request is recognised as Builder creation intent', () => {
  const request = 'Act as the Grandmaster app design/build agent. Design and implement one bounded accessibility improvement in the Bob panel: make durable run status changes clearly announced to screen readers, with focused tests and no unrelated UI changes. First inspect the current implementation and Atlas/schema impact, then create an isolated Builder job, implement and test the change, and prepare a draft pull request. Do not merge a protected branch, deploy production, or claim success without receipts. If a human confirmation is required, show selectable confirmation buttons.';
  assert.equal(explicitBuilderCreationRequest(request), true);
});

test('ordinary app-builder language is recognised without the internal Builder term', () => {
  assert.equal(explicitBuilderCreationRequest('Build me a small app for tracking patrol handovers with a mobile page and focused tests.'), true);
  assert.equal(explicitBuilderCreationRequest('Add an accessible page for reviewing welfare alerts and wire the existing workflow through it.'), true);
  assert.equal(explicitBuilderCreationRequest('Fix the broken Bob panel and add a regression test for the durable run status.'), true);
  assert.equal(explicitBuilderCreationRequest('Make this workflow work on mobile and keep the existing approval path.'), true);
  assert.equal(explicitBuilderCreationRequest('Complete and verify the structural Bob chat and Builder Studio redesign.'), true);
  assert.equal(explicitBuilderCreationRequest('Finish this UI redesign and run its tests.'), true);
});

test('Builder intent guard respects explicit plan-only and no-create instructions', () => {
  assert.equal(explicitBuilderCreationRequest('Plan only: explain how the Builder job would fix the Bob panel.'), false);
  assert.equal(explicitBuilderCreationRequest('Review the app code but do not create or open a Builder job.'), false);
  assert.equal(explicitBuilderCreationRequest('Create a client record for the new patrol customer.'), false);
  assert.equal(explicitBuilderCreationRequest('Run an Atlas gap scan, diagnose the cause, and recommend the next workstream.'), false);
  assert.equal(explicitBuilderCreationRequest('Fix the Bob panel component and add a focused test.'), true);
});

test('research URLs cannot be mistaken for repository paths when Builder chooses implementation lanes', () => {
  const pathsStart = chat.indexOf('    const builderRepositoryPaths = ');
  assert.ok(pathsStart >= 0);
  const pathsSource = chat.slice(pathsStart, chat.indexOf('    const builderJobArgsFromEvidence = ', pathsStart))
    .replace(/\(text: string\)/g, '(text)')
    .replace('(text: string, fallbackFrontend = false, fallbackBackend = true)', '(text, fallbackFrontend = false, fallbackBackend = true)');
  const builderRepositoryPaths = vm.runInNewContext(`(() => { ${pathsSource} return builderRepositoryPaths; })()`);
  const builderLanesForOwnerRequest = vm.runInNewContext(`(() => { ${pathsSource} return builderLanesForOwnerRequest; })()`);
  assert.deepEqual([...builderRepositoryPaths('Research https://example.com/ai-apps/ui-patterns for this UI redesign')], []);
  assert.deepEqual([...builderRepositoryPaths('Change apps/web/src/pages/BuilderControlRoomPage.tsx and test/builder.test.js')], [
    'apps/web/src/pages/BuilderControlRoomPage.tsx',
    'test/builder.test.js'
  ]);
  assert.deepEqual({ ...builderLanesForOwnerRequest('redesign the Bob Builder system UI UX') }, { frontend: true, backend: false });
  assert.deepEqual({ ...builderLanesForOwnerRequest('change the Builder API and schema') }, { frontend: false, backend: true });
  assert.deepEqual({ ...builderLanesForOwnerRequest('update the Builder UI and API') }, { frontend: true, backend: true });
});

test('research-driven Builder jobs preserve provenance and cannot open without four sources', () => {
  assert.match(chat, /step\.tool === 'web_research' \|\| step\.tool === 'delegate' \? 3500 : 500/);
  assert.match(chat, /Research source URLs supplied to Product Analyst/);
  assert.match(chat, /bjResearchRequired/);
  assert.match(chat, /bjResearchUrls\.length < 4/);
  assert.match(chat, /outcome: 'need_research'/);
});

test('explicit owner redesign research continues into Builder without another human turn', () => {
  assert.match(chat, /max_results: 8/);
  assert.match(chat, /sources\.slice\(0, 8\)/);
  assert.match(chat, /chosenTool === 'web_research'[\s\S]*explicitBuilderCreationRequest\(message\)/);
  assert.match(chat, /Number\(result\.meta\.source_count \|\| 0\) < 4/);
  assert.match(chat, /const proposalArgs = builderJobArgsFromEvidence\(message, researchSteps\)/);
  assert.match(chat, /result\.meta\.research_attempts = researchSteps\.length/);
  assert.match(chat, /LOOP_CONTINUABLE_READ_TOOLS\.has\(chosenTool\) \|\| chosenTool === 'web_research'/);
  assert.match(chat, /builderJobArgsFromEvidence\(message, loopSteps\)/);
  assert.match(chat, /const delegatedWebResearch = subagentRunsThisTurn\.filter/);
  assert.match(chat, /step\?\.tool === 'web_research' && step\?\.outcome === 'ok'/);
  assert.match(chat, /example\\\.com/);
  assert.match(chat, /Governed web research supplied by Bob’s research subagent/);
});
