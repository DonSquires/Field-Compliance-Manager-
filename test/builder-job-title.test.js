const test = require('node:test');
const assert = require('node:assert/strict');

test('Builder job titles are short outcome summaries, not raw chat messages', async () => {
  const { builderJobTitle, BUILDER_JOB_TITLE_MAX } = await import('../supabase/functions/_shared/builder-job-title.mjs');
  const raw = 'subagent has found a restriction that i think needs to be removed : The only verified single-file Atlas seed surface that would close the identified BuilderLiveActivity gap';
  const title = builderJobTitle(raw);
  assert.equal(title, 'Subagent has found a restriction that i think needs to be removed');
  assert.equal(builderJobTitle('please can you add a back button to the vehicle search page. thanks'), 'Add a back button to the vehicle search page');
  assert.equal(builderJobTitle('Repair Atlas gaps one by one'), 'Repair Atlas gaps one by one');
  assert.equal(builderJobTitle('   '), 'Implement the requested FCM change');
  const long = builderJobTitle('Redesign the vehicle search page so officers can review plates, owners, linked people, photos and observations together without scrolling');
  assert.ok(long.length <= BUILDER_JOB_TITLE_MAX + 1 && long.endsWith('…'));
});
