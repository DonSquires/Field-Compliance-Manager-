// Reads the anchor/replacement rows of the 2026-11-01 "client approval is not a condition of
// service" migration so tests can apply the same rewrite to catalog or migration function text.
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', '..', 'supabase', 'migrations',
  '20261102110000_service_without_client_approval.sql');

const literal = String.raw`(\$q\$[\s\S]*?\$q\$|E'(?:[^'\\]|''|\\.)*'|'')`;
const specRow = new RegExp(String.raw`\((\d+), '([^']+)', ${literal},\s*${literal}, (\d+)\)`, 'g');

const decode = value => {
  if (value === "''") return '';
  if (value.startsWith('$q$')) return value.slice(3, -3);
  return value.slice(2, -1).replace(/''/g, "'")
    .replace(/\\([nrt\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[c]);
};

function approvalSpecs(sql = fs.readFileSync(migrationPath, 'utf8')) {
  return [...sql.matchAll(specRow)].map(m => ({
    step: Number(m[1]),
    target: m[2],
    name: m[2].slice(0, m[2].indexOf('(')),
    anchor: decode(m[3]),
    replacement: decode(m[4]),
    expected: Number(m[5]),
  }));
}

const occurrences = (text, needle) => text.split(needle).length - 1;

function functionBlocks(sql, name) {
  const [schema, fn] = name.split('.');
  const header = new RegExp(String.raw`CREATE OR REPLACE FUNCTION\s+(?:"${schema}"|${schema})\.(?:"${fn}"|${fn})\(`, 'gi');
  return [...sql.matchAll(header)].map(match => {
    const tag = sql.slice(match.index).match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
    const bodyStart = match.index + tag.index + tag[0].length;
    return { start: match.index, end: sql.indexOf(tag[1], bodyStart) + tag[1].length };
  });
}

// Provider-side acceptance or confirmation predicates that the ruling removes.
const acceptanceGates = body => [
  ...body.matchAll(/invitation_status\s*(?:=|<>|!=)\s*'accepted'/gi),
  ...body.matchAll(/invitation_status\s+(?:not\s+)?in\s*\(/gi),
  ...body.matchAll(/'engagement_confirmation'\s*->>\s*'confirmed_by'\s+is\s+not\s+null/gi),
].map(match => match[0]);

// Rewrites every definition of each targeted function found in `sql`. A block must contain each
// anchor exactly as often as the migration expects, or not at all once the catalog already holds
// the rewritten body. Line endings inside rewritten blocks are normalised to LF.
function applyApprovalRuling(sql, specs = approvalSpecs()) {
  const applied = new Map(specs.map(spec => [spec.step, 0]));
  const blocks = [];
  for (const name of new Set(specs.map(spec => spec.name))) {
    for (const block of functionBlocks(sql, name)) blocks.push({ ...block, name });
  }
  blocks.sort((a, b) => b.start - a.start);
  let result = sql;
  for (const block of blocks) {
    let body = result.slice(block.start, block.end).replace(/\r\n/g, '\n');
    for (const spec of specs.filter(candidate => candidate.name === block.name)) {
      const count = occurrences(body, spec.anchor);
      if (count !== 0 && count !== spec.expected) {
        throw new Error(`step ${spec.step}: ${spec.target} has ${count} anchor match(es), expected ${spec.expected}`);
      }
      body = body.split(spec.anchor).join(spec.replacement);
      applied.set(spec.step, applied.get(spec.step) + count);
    }
    result = result.slice(0, block.start) + body + result.slice(block.end);
  }
  return { sql: result, applied };
}

module.exports = { migrationPath, approvalSpecs, functionBlocks, acceptanceGates, applyApprovalRuling };
