'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../supabase/functions/submit-dispute/index.ts'), 'utf8')
  .replace(/import \{ serve \} from '[^']+';/, '')
  .replace(/import \{ createClient \} from '[^']+';/, '');

function fixture({ lookup = { data: { id: 'notice-id', organization_id: 'org-id' }, error: null }, insertError = null } = {}) {
  let handler;
  const inserts = [];
  const logs = [];
  const client = {
    from(table) {
      if (table === 'infringement_notices') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return lookup; },
        };
      }
      if (table === 'disputes') {
        return {
          async insert(value) {
            inserts.push(value);
            return { error: insertError };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), {
    serve: (fn) => { handler = fn; },
    createClient: () => client,
    Deno: { env: { get: () => 'synthetic' } },
    Response,
    Error,
    console: { error: (...args) => logs.push(args) },
  });
  return { handler, inserts, logs };
}

function request() {
  return {
    method: 'POST',
    json: async () => ({
      notice_number: 'TEST-1',
      submitter_name: 'Synthetic',
      grounds: ['Other'],
      statement: 'Synthetic statement',
    }),
  };
}

test('lookup failure is logged safely and does not attempt an insert', async () => {
  const f = fixture({ lookup: { data: null, error: { code: 'XX001', message: 'private lookup detail' } } });
  const response = await f.handler(request());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Could not submit dispute' });
  assert.equal(f.inserts.length, 0);
  assert.match(JSON.stringify(f.logs), /XX001/);
  assert.doesNotMatch(JSON.stringify(f.logs), /private lookup detail/);
});

test('insert failure does not expose database details in the response or logs', async () => {
  const f = fixture({ insertError: { code: '23502', message: 'private insert detail' } });
  const response = await f.handler(request());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Could not submit dispute' });
  assert.match(JSON.stringify(f.logs), /23502/);
  assert.doesNotMatch(JSON.stringify(f.logs), /private insert detail/);
});

test('unexpected failures are logged without exposing exception details', async () => {
  const f = fixture();
  const response = await f.handler({ method: 'POST', json: async () => { throw new Error('private exception detail'); } });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Server error' });
  assert.ok(f.logs.length);
  assert.doesNotMatch(JSON.stringify(f.logs), /private exception detail/);
  assert.equal(f.inserts.length, 0);
});

test('successful mocked inserts retain their existing response and routing', async () => {
  const f = fixture();
  const response = await f.handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, matched_notice: true });
  assert.equal(f.inserts.length, 1);
  assert.equal(f.inserts[0].organization_id, 'org-id');
  assert.equal(f.inserts[0].notice_id, 'notice-id');
});
