const test = require('node:test');
const assert = require('node:assert/strict');

test('read-loop deduplication retains nested search values but ignores object key order', async () => {
  const { toolSignature } = await import('../supabase/functions/_shared/tool-signature.mjs');
  const first = toolSignature('query_records', { query: 'find_org', args: { name: 'NMDHB' } });
  const alternative = toolSignature('query_records', { query: 'find_org', args: { name: 'Nelson Marlborough' } });
  assert.notEqual(first, alternative);
  assert.equal(first, toolSignature('query_records', { args: { name: 'NMDHB' }, query: 'find_org' }));
  assert.notEqual(first, toolSignature('query_records', { query: 'find_org', args: { name: 'NMDHB', limit: 5 } }));
});

test('tool signatures preserve array order, nested fields, and tool identity', async () => {
  const { toolSignature } = await import('../supabase/functions/_shared/tool-signature.mjs');
  const args = { actions: [{ id: 'one', filters: { b: 2, a: 1 } }, { id: 'two' }] };
  assert.equal(toolSignature('read', args), toolSignature('read', { actions: [{ filters: { a: 1, b: 2 }, id: 'one' }, { id: 'two' }] }));
  assert.notEqual(toolSignature('read', args), toolSignature('read', { actions: [...args.actions].reverse() }));
  assert.notEqual(toolSignature('read', args), toolSignature('other', args));
});
