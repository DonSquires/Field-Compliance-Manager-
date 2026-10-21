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

test('Builder chat corrections: context sentences, Atlas gap targets, and echoed proposals', async () => {
  const { builderJobTitle, atlasGapTargets, stripBuilderProposalEchoes } = await import('../supabase/functions/_shared/builder-job-title.mjs');
  const live = 'that last job was rejected as it was a job that has been supaseeded. \nan atlas gap compact_cctv_inference_results is one we should test the update on';
  assert.equal(builderJobTitle(live), 'Close Atlas gap: compact_cctv_inference_results');
  assert.deepEqual(atlasGapTargets(live), ['compact_cctv_inference_results']);
  assert.deepEqual(atlasGapTargets('fix the vehicle_people table'), []);
  assert.equal(builderJobTitle('The vehicle page is slow. Please add pagination to the vehicle list.'), 'Add pagination to the vehicle list');
  const brief = [
    'Builder mode: chat_to_code',
    'Evidence gathered before proposal:',
    'repo_search: status: found',
    '- AGENTS.md:81',
    'create_builder_job: Started **Repair Atlas gaps one by one**',
    '',
    '**Title:** Unblock Atlas seed surface',
    'web_research: I can’t file the Builder job from this interface',
    'Required delivery contract:',
    '- Preserve Bob Builder job truth.'
  ].join('\n');
  const cleaned = stripBuilderProposalEchoes(brief);
  assert.match(cleaned, /repo_search: status: found\n- AGENTS\.md:81/);
  assert.doesNotMatch(cleaned, /Repair Atlas gaps|Unblock Atlas seed|can’t file/);
  assert.match(cleaned, /Required delivery contract:\n- Preserve Bob Builder job truth\./);
});
