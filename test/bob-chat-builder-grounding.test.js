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
  .replace(/\(text: string\)/g, '(text)');
const explicitBuilderCreationRequest = vm.runInNewContext(`(() => { ${builderIntentSource} return explicitBuilderCreationRequest; })()`);

const request = "In Bob's chat, whenever Bob asks me a question or proposes something that needs my confirmation — a Builder job proposal, a laptop command, a cancellation — show tappable choice buttons under his message, for example 'Yes, run it' / 'Change it' / 'No'. Server side, in supabase/functions/onspace-ai-chat/index.ts, include meta.options on every proposed outcome; client side, in apps/web/src/components/BobPanel.tsx, render metadata.options as accessible buttons. Add component tests.";

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
    .replace(/\(text: string\)/g, '(text)');
  const builderJobArgsFromEvidence = vm.runInNewContext(`(() => { ${argsSource} return builderJobArgsFromEvidence; })()`);
  assert.match(builderJobArgsFromEvidence('Build me a patrol handover app', []).task_description, /Builder mode: no_code_app_generation/);
  assert.match(builderJobArgsFromEvidence('Add an API-backed handover page', []).task_description, /Builder mode: chat_to_code/);
  assert.match(builderJobArgsFromEvidence('Repair the failing Builder test', []).task_description, /Builder mode: autonomous_self_heal/);
  assert.equal(builderJobArgsFromEvidence('Build me a patrol handover app', []).owner_instruction_confirmed, true);
});

test('an explicit owner build instruction opens the autonomous job without a second confirmation turn', () => {
  const builder = chat.slice(chat.indexOf("case 'create_builder_job':"), chat.indexOf("case 'cancel_builder_job':"));
  assert.match(builder, /const confirmedByOwnerInstruction = toolArgs\.owner_instruction_confirmed === true/);
  assert.match(builder, /bjRecentRequests\.some\(\(request\) => explicitBuilderCreationRequest/);
  assert.match(builder, /!storedJob && !confirmedByTriage && !confirmedByOwnerInstruction/);
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
});

test('Builder intent guard respects explicit plan-only and no-create instructions', () => {
  assert.equal(explicitBuilderCreationRequest('Plan only: explain how the Builder job would fix the Bob panel.'), false);
  assert.equal(explicitBuilderCreationRequest('Review the app code but do not create or open a Builder job.'), false);
  assert.equal(explicitBuilderCreationRequest('Create a client record for the new patrol customer.'), false);
});

test('research URLs cannot be mistaken for repository paths when Builder chooses implementation lanes', () => {
  const pathsStart = chat.indexOf('    const builderRepositoryPaths = ');
  assert.ok(pathsStart >= 0);
  const pathsSource = chat.slice(pathsStart, chat.indexOf('    const builderJobArgsFromEvidence = ', pathsStart))
    .replace('(text: string)', '(text)');
  const builderRepositoryPaths = vm.runInNewContext(`(() => { ${pathsSource} return builderRepositoryPaths; })()`);
  assert.deepEqual([...builderRepositoryPaths('Research https://example.com/ai-apps/ui-patterns for this UI redesign')], []);
  assert.deepEqual([...builderRepositoryPaths('Change apps/web/src/pages/BuilderControlRoomPage.tsx and test/builder.test.js')], [
    'apps/web/src/pages/BuilderControlRoomPage.tsx',
    'test/builder.test.js'
  ]);
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
