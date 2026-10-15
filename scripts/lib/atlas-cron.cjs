'use strict';

function readCallArguments(source, openParenIndex) {
  const args = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let index = openParenIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      current += character;
      if (character === "'" && source[index + 1] === "'") {
        current += source[index + 1];
        index += 1;
      } else if (character === "'") {
        inString = false;
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      current += character;
    } else if (character === '(') {
      depth += 1;
      current += character;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
      current += character;
    } else if (character === ')' && depth === 0) {
      args.push(current.trim());
      return args;
    } else if (character === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  return [];
}

function decodeSqlLiteral(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function extractCronOperations(source) {
  const operations = [];
  const schedulePattern = /\bcron\.schedule(?:_in_database)?\s*\(/gi;
  for (const match of source.matchAll(schedulePattern)) {
    const openParenIndex = (match.index ?? 0) + match[0].lastIndexOf('(');
    const args = readCallArguments(source, openParenIndex);
    const jobName = decodeSqlLiteral(args[0]);
    const schedule = decodeSqlLiteral(args[1]);
    const command = decodeSqlLiteral(args[2]);
    if (jobName && schedule && command) {
      operations.push({ kind: 'schedule', jobName, schedule, command, index: match.index ?? 0 });
    }
  }

  const unschedulePattern = /\bcron\.unschedule\s*\(/gi;
  for (const match of source.matchAll(unschedulePattern)) {
    const index = match.index ?? 0;
    const openParenIndex = index + match[0].lastIndexOf('(');
    const args = readCallArguments(source, openParenIndex);
    let jobName = decodeSqlLiteral(args[0]);
    if (!jobName) {
      const prior = source.slice(Math.max(0, index - 2000), index);
      const names = [...prior.matchAll(/\bjobname\s*=\s*'([^']+)'/gi)];
      jobName = names.at(-1)?.[1] ?? null;
    }
    if (jobName) operations.push({ kind: 'unschedule', jobName, index });
  }

  return operations.sort((left, right) => left.index - right.index);
}

function extractScheduledRpcName(command) {
  const match = String(command ?? '').match(
    /\b(?:select|perform)\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/i,
  );
  return match?.[1] ?? null;
}

module.exports = {
  extractCronOperations,
  extractScheduledRpcName,
};
