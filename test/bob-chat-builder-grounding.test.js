const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const chat = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const start = chat.indexOf('    const builderBriefGrounding = ');
assert.ok(start >= 0);
const source = chat.slice(start, chat.indexOf('    const builderCancellationDecision = ', start))
  .replace('(userText: string, brief: string)', '(userText, brief)')
  .replace(/\(text: string\)/g, '(text)')
  .replace(/\[\] as string\[\]/g, '[]')
  .replace(/\((w|p)\) =>/g, '($1) =>');
const builderBriefGrounding = vm.runInNewContext(`(() => { ${source} return builderBriefGrounding; })()`);

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

test('the create_builder_job proposal replaces an ungrounded draft with the owner\'s own words and says so', () => {
  const branch = chat.slice(chat.indexOf("case 'create_builder_job':"), chat.indexOf("case 'cancel_builder_job':"));
  assert.match(branch, /const bjGrounding = storedJob \? \{ grounded: true[^}]*\} : builderBriefGrounding\(message, `\$\{bjTitle\} \$\{bjDescription\}`\)/);
  assert.match(branch, /if \(!bjGrounding\.grounded\) \{/);
  assert.match(branch, /bjDescription = `\$\{ownWords\.slice\(0, 11000\)\}/);
  assert.match(branch, /so I have used your own words as the brief/);
  assert.match(branch, /grounding: \{ grounded: bjGrounding\.grounded, overlap: Number\(bjGrounding\.overlap\.toFixed\(2\)\), replaced_with_owner_words: !bjGrounding\.grounded \}/);
});
